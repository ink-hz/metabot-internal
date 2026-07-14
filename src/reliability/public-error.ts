export const RELIABILITY_ERROR_CLASSES = Object.freeze([
  'config_secret',
  'config_drift',
  'runtime_env',
  'metabot_process',
  'metabot_unresponsive',
  'feishu_connect',
  'feishu_recv',
  'feishu_download',
  'feishu_upload',
  'feishu_deliver',
  'feishu_receipt',
  'claude_preflight',
  'claude_session',
  'gateway_transport',
  'gateway_capability_required',
  'gateway_capability_optional',
  'model_mismatch',
  'tool_exec',
  'doc_toolchain',
  'file_validation',
  'timeout',
  'resource_disk',
  'resource_memory',
  'budget_exhausted',
  'observability_store',
  'alert_delivery',
  'probe_driver',
] as const);

export type ReliabilityErrorClass = typeof RELIABILITY_ERROR_CLASSES[number];

export interface PublicError {
  code: string;
  incidentId: string;
  message: string;
}

type PublicErrorTemplate = Omit<PublicError, 'incidentId'>;

const PUBLIC_ERRORS = Object.freeze({
  config_secret: { code: 'CONFIG_SECRET_NOT_READY', message: '服务凭据暂未就绪，维护者已收到通知。' },
  config_drift: { code: 'CONFIG_DRIFT', message: '服务配置与已验证版本不一致，维护者已收到通知。' },
  runtime_env: { code: 'RUNTIME_NOT_READY', message: '服务运行环境暂未就绪，维护者已收到通知。' },
  metabot_process: { code: 'SERVICE_PROCESS_UNAVAILABLE', message: '服务进程暂时不可用，维护者已收到通知。' },
  metabot_unresponsive: { code: 'SERVICE_UNRESPONSIVE', message: '服务暂时无响应，维护者已收到通知。' },
  feishu_connect: { code: 'FEISHU_NOT_CONNECTED', message: '飞书连接暂时不可用，维护者已收到通知。' },
  feishu_recv: { code: 'FEISHU_RECEIVE_FAILED', message: '消息未能被完整接收，请稍后重试。' },
  feishu_download: { code: 'ATTACHMENT_DOWNLOAD_FAILED', message: '附件暂时无法读取，请稍后重试。' },
  feishu_upload: { code: 'ATTACHMENT_UPLOAD_FAILED', message: '附件已生成，但暂时无法上传，维护者已收到通知。' },
  feishu_deliver: { code: 'MESSAGE_DELIVERY_FAILED', message: '结果未能完整送达，维护者已收到通知。' },
  feishu_receipt: { code: 'DELIVERY_UNCONFIRMED', message: '结果送达状态暂时无法确认，维护者已收到通知。' },
  claude_preflight: { code: 'CLAUDE_NOT_READY', message: 'Claude 运行环境暂未就绪，维护者已收到通知。' },
  claude_session: { code: 'CLAUDE_SESSION_FAILED', message: 'Claude 会话状态异常，请稍后重试。' },
  gateway_transport: { code: 'MODEL_GATEWAY_UNAVAILABLE', message: '模型服务连接暂时不可用，请稍后重试。' },
  gateway_capability_required: { code: 'REQUIRED_CAPABILITY_UNAVAILABLE', message: '本次任务所需的模型能力暂不可用，维护者已收到通知。' },
  gateway_capability_optional: { code: 'OPTIONAL_CAPABILITY_UNAVAILABLE', message: '一项可选模型能力当前不可用，其他已完成结果仍然有效。' },
  model_mismatch: { code: 'MODEL_MISMATCH', message: '实际模型与已验证配置不一致，维护者已收到通知。' },
  tool_exec: { code: 'TOOL_EXECUTION_FAILED', message: '工具执行未能完成，维护者已收到通知。' },
  doc_toolchain: { code: 'DOCUMENT_GENERATION_FAILED', message: '文档生成未能完成，维护者已收到通知。' },
  file_validation: { code: 'FILE_VALIDATION_FAILED', message: '生成文件未通过完整性检查，维护者已收到通知。' },
  timeout: { code: 'TASK_TIMEOUT', message: '本次处理超过时限，请缩小任务范围后重试。' },
  resource_disk: { code: 'DISK_CAPACITY_LOW', message: '服务存储空间不足，维护者已收到通知。' },
  resource_memory: { code: 'MEMORY_PRESSURE', message: '服务资源暂时不足，请稍后重试。' },
  budget_exhausted: { code: 'BUDGET_EXHAUSTED', message: '本次任务已达到预算上限，维护者已收到通知。' },
  observability_store: { code: 'OBSERVABILITY_UNAVAILABLE', message: '运行记录暂时不可用，但已完成结果不受影响。' },
  alert_delivery: { code: 'ALERT_DELIVERY_FAILED', message: '维护告警暂未送达，系统已保留关联记录。' },
  probe_driver: { code: 'RELIABILITY_PROBE_FAILED', message: '可靠性验证暂未完成，维护者已收到通知。' },
} satisfies Readonly<Record<ReliabilityErrorClass, PublicErrorTemplate>>);

const UNKNOWN_ERROR: PublicErrorTemplate = Object.freeze({
  code: 'UNEXPECTED_FAILURE',
  message: '本次处理未能完整完成，维护者已收到通知。',
});

export function toPublicError(errorClass: string, incidentId: string): PublicError {
  const template = Object.prototype.hasOwnProperty.call(PUBLIC_ERRORS, errorClass)
    ? PUBLIC_ERRORS[errorClass as ReliabilityErrorClass]
    : UNKNOWN_ERROR;
  return { ...template, incidentId };
}

export function classifyReliabilityError(message: string | undefined): ReliabilityErrorClass | 'unknown' {
  const value = message ?? '';
  if (/web_search|websearch|web_fetch|webfetch/i.test(value) && /not supported|unsupported|validationexception/i.test(value)) {
    return 'gateway_capability_optional';
  }
  if (/model.*(?:mismatch|not allowed|different)|actual model|configured model/i.test(value)) return 'model_mismatch';
  if (/no conversation found|conversation not found|session id|invalid session|thread\/resume.*failed|no rollout found|multiple.*tool_result.*blocks|each tool_use must have a single result/i.test(value)) {
    return 'claude_session';
  }
  if (/(?:spawn|executable|claude)[^\n]*(?:\bENOENT\b|permission denied|EACCES)|claude.*version/i.test(value)) {
    return 'claude_preflight';
  }
  if (/ENOSPC|no space left|disk.*full/i.test(value)) return 'resource_disk';
  if (/heap out of memory|ENOMEM|memory pressure/i.test(value)) return 'resource_memory';
  if (/budget|spend limit|max[_ ]budget/i.test(value)) return 'budget_exhausted';
  if (/timeout|timed out/i.test(value)) return 'timeout';
  if (/pandoc|docx|document generation|pdf generation/i.test(value)) return 'doc_toolchain';
  if (/checksum|signature|empty file|file validation/i.test(value)) return 'file_validation';
  if (/tool[_ ](?:use|execution)|tool .*failed/i.test(value)) return 'tool_exec';
  if (/ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|socket hang up|gateway.*(?:502|503|504)|(?:502|503|504).*gateway/i.test(value)) {
    return 'gateway_transport';
  }
  return 'unknown';
}
