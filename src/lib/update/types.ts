export interface UpdateStatus {
  checking: boolean;
  available: boolean;
  downloading: boolean;
  downloaded: boolean;
  error: string | null;
  version: string | null;
  releaseNotes: string | null;
  progress: {
    downloaded: number;
    total: number | null;
  };
}

export interface BrokerVersionInfo {
  version: string;
  download_url: string;
  release_notes: string | null;
}

export interface BrokerStartResult {
  already_running: boolean;
  ready: boolean;
  pid: number | null;
  installed_path: string;
  heartbeat_path: string;
  stdout_path: string;
  stderr_path: string;
  log_path: string;
  node_path: string | null;
  last_error: string | null;
}

export type UpdateEventCallback = (status: UpdateStatus) => void;
