// Package calls holds live call state: who is in a call, and what stage it is
// at. State lives in Redis with a TTL because it is ephemeral by nature — the
// durable record is the events published to JetStream, which messenger-service
// projects into call history.
package calls

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"datha-platform/realtime-service/internal/kv"
)

// Statuses of a call.
const (
	StatusRinging = "ringing"
	StatusActive  = "active"
)

// Reasons a call ends. They travel to the client in `call.ended` and into the
// event payload, so the UI can say "declined" rather than "call failed".
const (
	ReasonHangup            = "hangup"
	ReasonDeclined          = "declined"
	ReasonMissed            = "missed"
	ReasonBusy              = "busy"
	ReasonICEFailed         = "ice_failed"
	ReasonAnsweredElsewhere = "answered_elsewhere"
	// ReasonEmpty ends a group call that has run out of people. It is a server
	// conclusion: the last participants left one at a time and nobody hung the
	// call up, so no client can assert it.
	ReasonEmpty = "empty"
)

// ClientReasons are the end reasons a client is allowed to assert. `missed`,
// `answered_elsewhere` and `empty` are server conclusions and are rejected
// from a frame.
var ClientReasons = map[string]bool{
	ReasonHangup:    true,
	ReasonDeclined:  true,
	ReasonBusy:      true,
	ReasonICEFailed: true,
}

// ErrNotFound means the call is unknown or has expired.
var ErrNotFound = errors.New("call not found")

// ErrConversationBusy means that conversation already has a live call. The
// call's id travels with it, because the only useful answer to "a call is
// already happening here" is to join that one.
type ErrConversationBusy struct{ CallID string }

func (e ErrConversationBusy) Error() string {
	return "conversation already has a live call: " + e.CallID
}

// ErrFull means the call already holds as many participants as a mesh can
// carry. Separate from a plain refusal because the client says something
// different about it.
var ErrFull = errors.New("call is full")

// Media is how a call was set up. It is on the record rather than derived,
// because call history renders a video call differently from an audio one and
// the SDP that would otherwise carry the answer is opaque to this service.
const (
	MediaAudio = "audio"
	MediaVideo = "video"
)

// ValidMedia reports whether m is a media kind this service accepts. The frame
// handler defaults an absent value before the registry sees it, so an empty
// string here is a bug rather than an old client.
func ValidMedia(m string) bool { return m == MediaAudio || m == MediaVideo }

// Call is the live state of one call, 1:1 or group.
//
// Participants is the **invited set**, fixed when the call is created from the
// conversation's membership and never widened afterwards. It is the whole
// authorization surface for signaling: a frame may be targeted at someone in
// this list and at nobody else. Deriving it server-side is what stops the
// socket becoming a way to ring, or to trickle candidates at, a stranger.
//
// Who has actually *joined* is separate, mutable, and lives in a Redis hash —
// see Members. Keeping the two apart is what lets the hot path stay one read:
// relaying a candidate needs the invited set only, and a real ICE gather emits
// dozens of candidates in a second.
//
// CallerID is who started it. CalleeID is populated for a 1:1 call only, and
// stays on the record because the call-history projection in messenger-service
// keys on it; a group call leaves it empty and carries Participants instead.
type Call struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	CallerID       string    `json:"caller_id"`
	CalleeID       string    `json:"callee_id,omitempty"`
	Participants   []string  `json:"participants"`
	Media          string    `json:"media"`
	Status         string    `json:"status"`
	StartedAt      time.Time `json:"started_at"`
	AnsweredAt     time.Time `json:"answered_at,omitzero"`
}

// Member is one person's presence in a call.
//
// ConnID is the connection currently holding the place, and is what makes a
// closing socket able to remove *its own* entry without evicting a newer one.
// SessionID is the client's stable identifier for a browser tab across a
// reload: a new connection carrying a session that already holds the field is
// the same tab coming back, and takes it over rather than losing to it.
type Member struct {
	OwnerID   string `json:"owner_id"`
	ConnID    string `json:"conn_id"`
	SessionID string `json:"session_id,omitempty"`
	// InstanceID names the process holding this connection, so a member left
	// behind by an instance that died can be told from a live one. Empty on
	// entries written before this existed, which are treated as alive.
	InstanceID string    `json:"instance_id,omitempty"`
	JoinedAt   time.Time `json:"joined_at"`
}

// IsGroup reports whether this call needs a mesh rather than a single pair.
func (c *Call) IsGroup() bool { return len(c.Participants) > 2 }

// Peer returns the other participant of a 1:1 call, or "" when there is no
// single other participant — which is every group call, and is why a group
// frame must name its target explicitly.
func (c *Call) Peer(ownerID string) string {
	// A stranger gets no peer, independently of any check the caller may also
	// do. Returning "the participant who is not you" would hand an outsider
	// the first member of the list.
	if len(c.Participants) != 2 || !c.HasParticipant(ownerID) {
		return ""
	}
	for _, participant := range c.Participants {
		if participant != ownerID {
			return participant
		}
	}
	return ""
}

// HasParticipant reports membership of the invited set — checked before any
// signaling frame is relayed, in either direction.
func (c *Call) HasParticipant(ownerID string) bool {
	for _, participant := range c.Participants {
		if participant == ownerID {
			return true
		}
	}
	return false
}

// Others returns the invited set without ownerID.
func (c *Call) Others(ownerID string) []string {
	others := make([]string, 0, len(c.Participants))
	for _, participant := range c.Participants {
		if participant != ownerID {
			others = append(others, participant)
		}
	}
	return others
}

// Store is the Redis surface this package needs, kept narrow so tests need no
// server.
type Store interface {
	SetWithTTL(ctx context.Context, key, value string, ttl time.Duration) error
	Get(ctx context.Context, key string) (string, error)
	Delete(ctx context.Context, keys ...string) error
	HJoin(ctx context.Context, key, field, value, sessionID string, ttl time.Duration) (bool, error)
	HGetAll(ctx context.Context, key string) (map[string]string, error)
	HDel(ctx context.Context, key, field string) error
	HDelIfHeldBy(ctx context.Context, key, field, connID string) (bool, error)
	SAddWithTTL(ctx context.Context, key, member string, ttl time.Duration) error
	SRem(ctx context.Context, key, member string) error
	SMembers(ctx context.Context, key string) ([]string, error)
	KeysWithPrefix(ctx context.Context, prefix string) ([]string, error)
	Consume(ctx context.Context, key string) (bool, error)
	ClaimWithTTL(ctx context.Context, key, value string, ttl time.Duration) (bool, string, error)
	StealWithTTL(ctx context.Context, key, value string, ttl time.Duration) error
}

// Registry reads and writes live call state.
type Registry struct {
	store Store
	// ringingTTL only garbage-collects an abandoned invite; the 30 s missed
	// timeout is a timer in the service, so it can publish `call.missed`.
	ringingTTL time.Duration
	activeTTL  time.Duration
	// maxParticipants is the mesh ceiling: every peer holds N-1 connections and
	// uplinks its own video N-1 times, so this is a media limit, not a policy
	// one. A group conversation may hold far more people than a call can.
	maxParticipants int
	// instanceID is stamped on every member this process writes, so a crashed
	// instance's calls can be found and closed rather than expiring silently.
	instanceID string
	now        func() time.Time
}

// NewRegistry builds a registry. activeTTL is the ceiling on a single call, and
// is generous on purpose: expiry here is cleanup after a crashed instance, not
// a call-duration limit.
func NewRegistry(store Store, ringingTTL, activeTTL time.Duration, maxParticipants int) *Registry {
	return &Registry{
		store:           store,
		ringingTTL:      ringingTTL,
		activeTTL:       activeTTL,
		maxParticipants: maxParticipants,
		now:             time.Now,
	}
}

// WithInstance stamps members written by this registry with the instance id,
// which is what makes a crashed process's calls identifiable afterwards.
func (r *Registry) WithInstance(instanceID string) *Registry {
	r.instanceID = instanceID
	return r
}

// MaxParticipants is the mesh ceiling this registry enforces.
func (r *Registry) MaxParticipants() int { return r.maxParticipants }

func key(callID string) string { return "call:" + callID }

// conversationKey names the one live call a conversation may have.
//
// Every mainstream client works this way — Messenger, Teams, Slack, WhatsApp —
// and it is not only a UI convention: without it a third person pressing Call
// during a call creates a *second* one, everybody already talking gets rung
// again, and the client's glare rule (written for two people dialling each
// other in a 1:1) makes the polite side hang up the call it is in to take the
// new ring. One press could empty a room (found 2026-09-15).
func conversationKey(conversationID string) string {
	return "call:conv:" + conversationID
}
func membersKey(callID string) string { return "call:" + callID + ":members" }
func joinedKey(callID string) string  { return "call:" + callID + ":joined" }

// ownerKey indexes the live calls one person is invited to.
//
// Without it a client that connects *after* the ring has no way to learn it is
// wanted: `call.incoming` goes out over core NATS, which drops a frame nobody
// is listening for, and a call nobody has answered yet has no history row
// either, because `messenger.call.started` is published on the transition to
// active. So the only record is Redis, and Redis has no way to ask "which
// calls is this owner in" without scanning every key — which is exactly the
// kind of thing that works on a dev box and falls over on a real one.
//
// Written for every invited person, not only the ones who join, because the
// question being answered is "should this person be ringing".
func ownerKey(ownerID string) string { return "call:owner:" + ownerID }

// dismissedKey names the people who have already said no to this call.
//
// Separate from the joined set, which is append-only *and* feeds call history:
// writing a decliner there would record them as having been on a call they
// refused. Both sets answer "has this person already decided", which is the
// question a connect-time ring has to ask.
func dismissedKey(callID string) string { return "call:" + callID + ":dismissed" }

// Create records a ringing call and joins the caller to it.
//
// The caller is a member from the start: they are already in the room they are
// ringing, and every other rule — when the call is empty, who a newcomer must
// negotiate with — then reads from one place.
func (r *Registry) Create(ctx context.Context, call *Call, connID, sessionID string) error {
	call.Status = StatusRinging
	call.StartedAt = r.now().UTC()
	sort.Strings(call.Participants)

	// The conversation is claimed before anything is written, and atomically.
	// A check-then-create would let two simultaneous invites both find the
	// conversation free — which is the exact case this exists for.
	if err := r.claimConversation(ctx, call); err != nil {
		return err
	}

	if err := r.save(ctx, call, r.ringingTTL); err != nil {
		// Nothing is holding the claim now, so it must not outlive the attempt
		// or the conversation is uncallable until it expires.
		_ = r.store.Delete(ctx, conversationKey(call.ConversationID))
		return err
	}

	/*
	 * Index the call under everyone it rings, so a socket connecting mid-ring
	 * can find it. The TTL is the active one rather than the ringing one: the
	 * index has to outlive the ring for a call that gets answered, and a stale
	 * entry is harmless because `PendingFor` loads each call and drops the ids
	 * that no longer resolve.
	 *
	 * A failure here is logged by the caller, never fatal — it costs a late
	 * client its ring, and failing the whole invite instead would take the
	 * call away from the people who *are* connected.
	 */
	for _, ownerID := range call.Participants {
		if err := r.store.SAddWithTTL(
			ctx, ownerKey(ownerID), call.ID, r.activeTTL,
		); err != nil {
			return fmt.Errorf("index call %s for %s: %w", call.ID, ownerID, err)
		}
	}
	if _, err := r.Join(ctx, call, call.CallerID, connID, sessionID); err != nil {
		return err
	}
	return nil
}

// Dismiss records that somebody has refused this call, so it stops ringing them
// for good.
//
// Declining is a decision, and a decision has to outlive the socket that made
// it — otherwise reloading the page rings them again with the call they just
// turned down.
func (r *Registry) Dismiss(ctx context.Context, callID, ownerID string) error {
	if err := r.store.SAddWithTTL(
		ctx, dismissedKey(callID), ownerID, r.activeTTL,
	); err != nil {
		return fmt.Errorf("dismiss %s for %s: %w", callID, ownerID, err)
	}
	return nil
}

// PendingFor lists the live calls this person is invited to but has not joined.
//
// The answer to "did I miss a ring while I was away". A call.incoming frame is
// published over core NATS, which delivers to whoever is listening at that
// instant and to nobody else, so a person who signs in mid-ring has no way to
// discover the call: it has no history row either, because that is written
// when somebody answers. This reads the state instead of replaying the event,
// which is the same move click-to-join made — and it cannot go stale, because
// it is derived from the call record every time it is asked.
//
// Calls this person is already in are excluded. A tab that holds the call
// wants no ring, and a *second* tab of theirs is the `answered_elsewhere` case,
// which the join path already owns.
//
// Ids that no longer resolve are skipped rather than reported: the index is
// cleaned on End, but a call whose instance died leaves its entry behind until
// the TTL, and a caller asking to be rung by a call that no longer exists is
// worse than saying nothing.
func (r *Registry) PendingFor(ctx context.Context, ownerID string) ([]*Call, error) {
	ids, err := r.store.SMembers(ctx, ownerKey(ownerID))
	if err != nil {
		return nil, fmt.Errorf("list calls for %s: %w", ownerID, err)
	}

	pending := make([]*Call, 0, len(ids))
	for _, id := range ids {
		call, err := r.Get(ctx, id)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !call.HasParticipant(ownerID) {
			continue
		}
		/*
		 * "Has this person already decided about this call?" — and the answer
		 * has to survive their socket, which is why neither half of it is the
		 * live member hash. Somebody who joined and then left is in the joined
		 * set forever; somebody who declined is in the dismissed set. Checking
		 * only who is *currently* in the call rang both of them again every
		 * time they reloaded the page (dathq, 2026-09-16: "i've joined and
		 * leave, when i reload i still got the call notice").
		 */
		decided, err := r.EverJoined(ctx, id)
		if err != nil {
			return nil, err
		}
		dismissed, err := r.store.SMembers(ctx, dismissedKey(id))
		if err != nil {
			return nil, fmt.Errorf("load dismissals of %s: %w", id, err)
		}
		if contains(decided, ownerID) || contains(dismissed, ownerID) {
			continue
		}
		pending = append(pending, call)
	}
	sort.Slice(pending, func(a, b int) bool {
		return pending[a].StartedAt.Before(pending[b].StartedAt)
	})
	return pending, nil
}

// Get loads a call, answering ErrNotFound once it has expired.
func (r *Registry) Get(ctx context.Context, callID string) (*Call, error) {
	raw, err := r.store.Get(ctx, key(callID))
	if errors.Is(err, kv.ErrNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("load call: %w", err)
	}
	var call Call
	if err := json.Unmarshal([]byte(raw), &call); err != nil {
		return nil, fmt.Errorf("decode call %s: %w", callID, err)
	}
	return &call, nil
}

// Join adds one owner to a call, reporting whether this connection now holds
// their place.
//
// The win is decided by an atomic script on the member hash, not by the call
// record: an invite reaches every tab a person has open, so two tabs can accept
// within milliseconds of each other and exactly one must proceed. The loser is
// told `answered_elsewhere` rather than a generic failure.
//
// The field is the **owner** id, so the race is per person. In a group that is
// exactly right: three people may join at once and each of them wins their own
// field, while each of their other tabs loses.
//
// A read-modify-write of a participant list would race here for real — two
// joins in the same tick and one of them vanishes — which is why membership is
// a hash of independent fields rather than an array on the call record.
//
// **A session may take its own field back.** A reloaded tab arrives as a new
// connection carrying the session it already had, which is the one case where
// "someone already holds this" means "you do" rather than "somebody else does".
// Without it a reload locks a person out of a call they are in until the TTL.
func (r *Registry) Join(ctx context.Context, call *Call, ownerID, connID, sessionID string) (bool, error) {
	if !call.HasParticipant(ownerID) {
		return false, nil
	}
	if ownerID != call.CallerID {
		members, err := r.Members(ctx, call.ID)
		if err != nil {
			return false, err
		}
		if len(members) >= r.maxParticipants && !hasOwner(members, ownerID) {
			return false, ErrFull
		}
	}

	member := Member{
		OwnerID:    ownerID,
		ConnID:     connID,
		SessionID:  sessionID,
		InstanceID: r.instanceID,
		JoinedAt:   r.now().UTC(),
	}
	data, err := json.Marshal(member)
	if err != nil {
		return false, fmt.Errorf("encode member %s: %w", ownerID, err)
	}
	won, err := r.store.HJoin(ctx, membersKey(call.ID), ownerID, string(data), sessionID, r.activeTTL)
	if err != nil {
		return false, fmt.Errorf("join call %s: %w", call.ID, err)
	}
	if won {
		// Recorded separately because the member hash is *who is here now* and
		// loses someone the moment they leave — which is the wrong answer for
		// the record of who was on the call. Someone who joins a four-way call
		// and drops out early was still on it.
		if err := r.store.SAddWithTTL(ctx, joinedKey(call.ID), ownerID, r.activeTTL); err != nil {
			return false, fmt.Errorf("record join on %s: %w", call.ID, err)
		}
	}
	return won, nil
}

// EverJoined lists everyone who joined at any point, in owner-id order, whether
// or not they are still in the call. This is what call history records.
func (r *Registry) EverJoined(ctx context.Context, callID string) ([]string, error) {
	joined, err := r.store.SMembers(ctx, joinedKey(callID))
	if err != nil {
		return nil, fmt.Errorf("load joined of %s: %w", callID, err)
	}
	sort.Strings(joined)
	return joined, nil
}

// NeverJoined lists the invited people who did not answer — the people a group
// call's `missed` events are about.
func (r *Registry) NeverJoined(ctx context.Context, call *Call) ([]string, error) {
	joined, err := r.EverJoined(ctx, call.ID)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(joined))
	for _, ownerID := range joined {
		seen[ownerID] = true
	}
	missed := make([]string, 0, len(call.Participants))
	for _, ownerID := range call.Participants {
		if !seen[ownerID] {
			missed = append(missed, ownerID)
		}
	}
	return missed, nil
}

// LeaveIfHeldBy removes one owner only while connID still holds their place,
// reporting whether it removed anything.
//
// This is what a closing socket calls. The condition is the whole point: a tab
// that reloads is replaced by its own new connection *before* the old socket's
// close is necessarily processed, and an unconditional removal there would drop
// a person out of a call they are sitting in. Answering false is the normal,
// expected outcome for a superseded connection — not an error.
func (r *Registry) LeaveIfHeldBy(ctx context.Context, callID, ownerID, connID string) (bool, error) {
	removed, err := r.store.HDelIfHeldBy(ctx, membersKey(callID), ownerID, connID)
	if err != nil {
		return false, fmt.Errorf("leave call %s: %w", callID, err)
	}
	return removed, nil
}

// Members lists everyone currently in the call, ordered by owner id.
//
// The order is what makes the mesh's pairing rule usable: with a stable sort
// both sides of a pair compute the same initiator without comparing notes.
func (r *Registry) Members(ctx context.Context, callID string) ([]Member, error) {
	raw, err := r.store.HGetAll(ctx, membersKey(callID))
	if err != nil {
		return nil, fmt.Errorf("load members of %s: %w", callID, err)
	}
	members := make([]Member, 0, len(raw))
	for ownerID, value := range raw {
		var member Member
		if err := json.Unmarshal([]byte(value), &member); err != nil {
			// One unreadable field must not hide the rest of the room.
			continue
		}
		if member.OwnerID == "" {
			member.OwnerID = ownerID
		}
		members = append(members, member)
	}
	sort.Slice(members, func(i, j int) bool {
		return members[i].OwnerID < members[j].OwnerID
	})
	return members, nil
}

// Leave removes one owner from the call. Leaving twice is not an error: a
// hang-up and a dropped socket can both report the same departure.
func (r *Registry) Leave(ctx context.Context, callID, ownerID string) error {
	if err := r.store.HDel(ctx, membersKey(callID), ownerID); err != nil {
		return fmt.Errorf("leave call %s: %w", callID, err)
	}
	return nil
}

// claimConversation takes the conversation's one call slot, or reports who has
// it.
//
// A claim whose call no longer exists is taken over rather than obeyed: the
// slot outliving its call — an instance that died between ending a call and
// releasing the key — would make the conversation uncallable for the rest of
// the TTL, which is a worse failure than the one being prevented.
func (r *Registry) claimConversation(ctx context.Context, call *Call) error {
	claimKey := conversationKey(call.ConversationID)
	won, holder, err := r.store.ClaimWithTTL(ctx, claimKey, call.ID, r.ringingTTL)
	if err != nil {
		return fmt.Errorf("claim conversation %s: %w", call.ConversationID, err)
	}
	if won {
		return nil
	}

	if _, err := r.Get(ctx, holder); err == nil {
		return ErrConversationBusy{CallID: holder}
	} else if !errors.Is(err, ErrNotFound) {
		return fmt.Errorf("check live call %s: %w", holder, err)
	}

	if err := r.store.StealWithTTL(ctx, claimKey, call.ID, r.ringingTTL); err != nil {
		return fmt.Errorf("reclaim conversation %s: %w", call.ConversationID, err)
	}
	return nil
}

// Activate transitions a ringing call to active. Idempotent: in a group the
// second and third people to join must not restamp the answer time.
func (r *Registry) Activate(ctx context.Context, call *Call) error {
	if call.Status == StatusActive {
		return nil
	}
	call.Status = StatusActive
	call.AnsweredAt = r.now().UTC()
	if err := r.save(ctx, call, r.activeTTL); err != nil {
		return err
	}
	// The claim was armed for a ringing call; an answered one lives far longer,
	// and a claim that expired under a live call would let a second call be
	// created in a conversation that is plainly busy.
	return r.store.StealWithTTL(
		ctx, conversationKey(call.ConversationID), call.ID, r.activeTTL)
}

// End removes a call, its member hash and its conversation claim, reporting
// whether this caller is the one that ended it.
//
// The call record is consumed first and the answer is a **claim**: a call can be
// ended by a hang-up, by the last socket closing and by another instance
// reaping it, and only one of those may announce it. Without the claim a reaped
// call could publish `call.ended` twice and write two history rows.
//
// It takes the call rather than an id because releasing the conversation needs
// the conversation, and a call that ended without releasing it would leave that
// conversation uncallable until the key expired.
func (r *Registry) End(ctx context.Context, call *Call) (bool, error) {
	mine, err := r.store.Consume(ctx, key(call.ID))
	if err != nil {
		return false, fmt.Errorf("end call %s: %w", call.ID, err)
	}
	// The rest is cleanup and runs either way: a loser of the claim still wants
	// its keys gone, and Delete on a missing key is not an error.
	if err := r.store.Delete(
		ctx,
		membersKey(call.ID),
		joinedKey(call.ID),
		dismissedKey(call.ID),
		conversationKey(call.ConversationID),
	); err != nil {
		return mine, fmt.Errorf("clean up call %s: %w", call.ID, err)
	}
	// One member out of each person's index, never the whole key: a person may
	// be in a second call in another conversation, and deleting their set would
	// stop that one ringing anybody who connects late.
	for _, ownerID := range call.Participants {
		if err := r.store.SRem(ctx, ownerKey(ownerID), call.ID); err != nil {
			return mine, fmt.Errorf("unindex call %s for %s: %w", call.ID, ownerID, err)
		}
	}
	return mine, nil
}

func (r *Registry) save(ctx context.Context, call *Call, ttl time.Duration) error {
	data, err := json.Marshal(call)
	if err != nil {
		return fmt.Errorf("encode call %s: %w", call.ID, err)
	}
	if err := r.store.SetWithTTL(ctx, key(call.ID), string(data), ttl); err != nil {
		return fmt.Errorf("save call %s: %w", call.ID, err)
	}
	return nil
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func hasOwner(members []Member, ownerID string) bool {
	for _, member := range members {
		if member.OwnerID == ownerID {
			return true
		}
	}
	return false
}

// Initiator names which of two participants sends the offer for their pair.
//
// Lexicographically lower owner id, matching Matrix's MSC3401 rule for full
// mesh: "for any two participants, the one with the lexicographically lower
// user ID is responsible for calling the other". Deliberately **not** "whoever
// was there first" — two people joining in the same instant each see the other
// as the newcomer, and arrival order is not knowable to both sides, while owner
// ids are.
//
// This settles who *starts*; a genuine collision is still resolved by perfect
// negotiation in the browser, which is a separate rule and already built.
func Initiator(a, b string) string {
	if a < b {
		return a
	}
	return b
}
