export interface UploadFileRequest {
  localPath: string;
  fileName: string;
  mimeType: string;
}

export interface UploadResult {
  fileId: string;
  fileName: string;
}

export interface StorageUploader {
  uploadFile(input: UploadFileRequest): Promise<UploadResult>;
}
