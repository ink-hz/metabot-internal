import type {
  DeliveryReceipt,
  ProbeStageReceipt,
  SyntheticProbeContext,
} from './probe-types.js';
import type { ProbeReceiptStore } from './probe-receipt-store.js';

export class ProbeObserver {
  constructor(
    private readonly store: ProbeReceiptStore,
    private readonly botName: string,
  ) {}

  stage(
    probe: SyntheticProbeContext | undefined,
    receipt: ProbeStageReceipt,
  ): void {
    if (!probe) return;
    try {
      this.store.record(probe, { ...receipt, botName: this.botName });
    } catch {
      // Observation never controls a user or synthetic turn.
    }
  }

  delivery(
    probe: SyntheticProbeContext | undefined,
    receipt: DeliveryReceipt,
  ): void {
    if (!probe) return;
    const at = new Date().toISOString();
    if (receipt.ok && receipt.messageId && receipt.fileKey) {
      this.stage(probe, {
        stage: 'file_delivered',
        at,
        messageId: receipt.messageId,
        fileKey: receipt.fileKey,
        ...(receipt.fileName ? { fileName: receipt.fileName } : {}),
      });
      return;
    }
    this.stage(probe, {
      stage: 'failed',
      at,
      ...(receipt.fileName ? { fileName: receipt.fileName } : {}),
      errorClass: 'feishu_deliver',
    });
  }
}
