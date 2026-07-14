export type ProbeStage =
  | 'feishu_received'
  | 'run_started'
  | 'run_completed'
  | 'tool_completed'
  | 'text_delivered'
  | 'file_delivered'
  | 'failed';

export interface SyntheticProbeContext {
  isSynthetic: true;
  probeId: string;
  attemptId: string;
}

export interface ProbeStageReceipt {
  stage: ProbeStage;
  at: string;
  messageId?: string;
  fileKey?: string;
  fileName?: string;
  sessionId?: string;
  model?: string;
  backend?: string;
  errorClass?: string;
}

export interface DeliveryReceipt {
  ok: boolean;
  kind: 'card' | 'text' | 'file' | 'image';
  messageId?: string;
  fileKey?: string;
  fileName?: string;
}
