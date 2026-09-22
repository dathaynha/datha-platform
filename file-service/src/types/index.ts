export type FileStatus = "pending" | "uploaded" | "deleted";

export interface FileRow {
  id: string;
  owner_id: string;
  name: string;
  mime_type: string | null;
  size_bytes: number | null;
  blob_path: string;
  status: FileStatus;
  origin: string | null;
  correlation_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}
