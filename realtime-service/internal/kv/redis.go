// Package kv is the service's single Redis client. Presence and live call state
// are both TTL'd key-value data with different shapes, so each owner declares
// its own narrow interface over this one connection pool rather than opening a
// second one.
package kv

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// ErrNotFound is returned by Get when a key is absent or has expired. Absence
// is a normal answer here — every key in this service is TTL'd by design.
var ErrNotFound = errors.New("key not found")

// Redis is the shared client.
type Redis struct {
	client *redis.Client
}

// NewRedis builds a client from a redis:// URL.
func NewRedis(url string) (*Redis, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	return &Redis{client: redis.NewClient(opts)}, nil
}

// Ping verifies the connection at startup, so a bad REDIS_URL fails fast.
func (s *Redis) Ping(ctx context.Context) error {
	if err := s.client.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis ping: %w", err)
	}
	return nil
}

// Close releases the pool.
func (s *Redis) Close() error { return s.client.Close() }

// SetWithTTL writes a key and arms its expiry.
func (s *Redis) SetWithTTL(ctx context.Context, key, value string, ttl time.Duration) error {
	return s.client.Set(ctx, key, value, ttl).Err()
}

// Get reads one key, answering ErrNotFound when it is absent or expired.
func (s *Redis) Get(ctx context.Context, key string) (string, error) {
	value, err := s.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("redis get: %w", err)
	}
	return value, nil
}

// ClaimWithTTL takes a key only if it is free, answering whether it did and
// what holds it.
//
// One round trip, because check-then-set is not the same operation: two people
// pressing Call in the same conversation at the same instant would both find it
// free and both create a call. SET NX is atomic, so exactly one wins and the
// loser is handed the winner's value to join instead.
func (s *Redis) ClaimWithTTL(
	ctx context.Context,
	key, value string,
	ttl time.Duration,
) (bool, string, error) {
	ok, err := s.client.SetArgs(ctx, key, value, redis.SetArgs{
		Mode: "NX",
		TTL:  ttl,
		Get:  true,
	}).Result()
	// GET on a SET NX that succeeded reports the *previous* value, which was
	// absent — that is the win, not a failure.
	if errors.Is(err, redis.Nil) {
		return true, value, nil
	}
	if err != nil {
		return false, "", fmt.Errorf("redis claim: %w", err)
	}
	return false, ok, nil
}

// StealWithTTL takes a key over unconditionally, for a claim whose owner is
// provably gone.
func (s *Redis) StealWithTTL(
	ctx context.Context,
	key, value string,
	ttl time.Duration,
) error {
	return s.client.Set(ctx, key, value, ttl).Err()
}

// Delete removes keys. Missing keys are not an error.
func (s *Redis) Delete(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	return s.client.Del(ctx, keys...).Err()
}

// Consume deletes one key and reports whether it was there to delete.
//
// The return value is a claim, not a statistic: exactly one caller may announce
// a call has ended, and DEL answering 1 is what says "it was mine to end".
func (s *Redis) Consume(ctx context.Context, key string) (bool, error) {
	removed, err := s.client.Del(ctx, key).Result()
	if err != nil {
		return false, fmt.Errorf("redis consume: %w", err)
	}
	return removed > 0, nil
}

// KeysWithPrefix scans for live keys. SCAN rather than KEYS: KEYS blocks the
// server for the whole keyspace, which is fine with three test users and not
// fine later.
func (s *Redis) KeysWithPrefix(ctx context.Context, prefix string) ([]string, error) {
	var (
		cursor uint64
		out    []string
	)
	for {
		keys, next, err := s.client.Scan(ctx, cursor, prefix+"*", 100).Result()
		if err != nil {
			return nil, fmt.Errorf("redis scan: %w", err)
		}
		out = append(out, keys...)
		if next == 0 {
			return out, nil
		}
		cursor = next
	}
}

// GetAll reads several keys in one round trip. Keys that are absent are simply
// missing from the result.
func (s *Redis) GetAll(ctx context.Context, keys []string) (map[string]string, error) {
	if len(keys) == 0 {
		return map[string]string{}, nil
	}
	values, err := s.client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, fmt.Errorf("redis mget: %w", err)
	}
	out := make(map[string]string, len(keys))
	for i, key := range keys {
		if i < len(values) {
			if str, ok := values[i].(string); ok {
				out[key] = str
			}
		}
	}
	return out, nil
}

// joinScript claims one field of a hash for a session, first-wins **except**
// that the same session may take its own field back.
//
// Both halves have to be one atomic step. A read-then-write would let a tab
// reloading and a second tab racing the same field interleave, and the whole
// point of this primitive is that exactly one connection holds a person's place
// in a call at any instant.
//
// The takeover is what makes a reload work. A reloaded tab is a *new*
// connection holding the *same* session, so it is the same person coming back
// rather than a second tab joining — and it replaces the stored `conn_id`,
// which is then what makes the old socket's own cleanup a no-op when it
// arrives late. An empty session never takes over: a client that supplies none
// gets the plain first-wins behaviour.
var joinScript = redis.NewScript(`
local existing = redis.call('HGET', KEYS[1], ARGV[1])
local won = 0
if existing == false then
  won = 1
elseif ARGV[3] ~= '' then
  local ok, decoded = pcall(cjson.decode, existing)
  if ok and decoded.session_id == ARGV[3] then won = 1 end
end
if won == 1 then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return won
`)

// leaveScript removes a field only while the given connection still holds it.
//
// Unconditional removal is wrong on exactly the case this exists for: a tab
// reloads, the new connection takes the field over, and *then* the old socket's
// close is processed. An unconditional HDEL there would evict the live tab and
// drop the person out of a call they are sitting in.
var leaveScript = redis.NewScript(`
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if existing == false then return 0 end
local ok, decoded = pcall(cjson.decode, existing)
if ok and decoded.conn_id == ARGV[2] then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return 1
end
return 0
`)

// HJoin claims a hash field for one session, reporting whether this caller now
// holds it, and re-arms the hash's expiry.
func (s *Redis) HJoin(ctx context.Context, key, field, value, sessionID string, ttl time.Duration) (bool, error) {
	won, err := joinScript.Run(ctx, s.client, []string{key},
		field, value, sessionID, int(ttl.Seconds())).Int()
	if err != nil {
		return false, fmt.Errorf("redis join script: %w", err)
	}
	return won == 1, nil
}

// HDelIfHeldBy removes a hash field only if connID still holds it, reporting
// whether it removed anything.
func (s *Redis) HDelIfHeldBy(ctx context.Context, key, field, connID string) (bool, error) {
	removed, err := leaveScript.Run(ctx, s.client, []string{key}, field, connID).Int()
	if err != nil {
		return false, fmt.Errorf("redis leave script: %w", err)
	}
	return removed == 1, nil
}

// HGetAll reads every field of a hash. An absent hash is an empty map, not an
// error: a call whose members have all left looks exactly like one that never
// had any.
func (s *Redis) HGetAll(ctx context.Context, key string) (map[string]string, error) {
	values, err := s.client.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, fmt.Errorf("redis hgetall: %w", err)
	}
	return values, nil
}

// SAddWithTTL records one member of a set and re-arms the set's expiry.
//
// Used for the "ever joined" set behind call history. It only ever grows: the
// member hash answers *who is in the call now* and loses someone the moment
// they leave, which is the wrong answer for a record of who was on the call.
func (s *Redis) SAddWithTTL(ctx context.Context, key, member string, ttl time.Duration) error {
	pipe := s.client.TxPipeline()
	pipe.SAdd(ctx, key, member)
	pipe.Expire(ctx, key, ttl)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("redis sadd: %w", err)
	}
	return nil
}

// SRem removes one member from a set, leaving the rest of the set alone.
//
// The counterpart to SAddWithTTL for an index keyed by *person* rather than by
// call: one owner may be in two calls at once (one per conversation), so
// ending a call must take out that call's id and nothing else. Deleting the
// key would silently stop the other call ringing.
//
// Removing a member that is not there is not an error, which is what makes the
// cleanup safe to run twice.
func (s *Redis) SRem(ctx context.Context, key, member string) error {
	if err := s.client.SRem(ctx, key, member).Err(); err != nil {
		return fmt.Errorf("redis srem: %w", err)
	}
	return nil
}

// SMembers reads a set. An absent set is empty, not an error.
func (s *Redis) SMembers(ctx context.Context, key string) ([]string, error) {
	members, err := s.client.SMembers(ctx, key).Result()
	if err != nil {
		return nil, fmt.Errorf("redis smembers: %w", err)
	}
	return members, nil
}

// HDel removes one field unconditionally. A field that was already gone is not
// an error — a hang-up and a dropped socket can report the same departure.
func (s *Redis) HDel(ctx context.Context, key, field string) error {
	if err := s.client.HDel(ctx, key, field).Err(); err != nil {
		return fmt.Errorf("redis hdel: %w", err)
	}
	return nil
}
