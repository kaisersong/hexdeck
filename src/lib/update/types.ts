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

export type UpdateEventCallback = (status: UpdateStatus) => void;