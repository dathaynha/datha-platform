export interface UserRow {
  id: string;
  owner_id: string;
  email: string;
  display_name: string;
  picture_url: string;
  created_at: Date;
  updated_at: Date;
  last_seen_at: Date;
}

export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  created_at: Date;
}

export interface DirectoryRow {
  owner_id: string;
  email: string;
  display_name: string;
  picture_url: string;
}
