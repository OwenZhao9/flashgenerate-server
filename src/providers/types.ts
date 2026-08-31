/**
 * 供应商抽象层。
 *
 * 这是整套系统唯一允许出现「某一家供应商特有概念」的地方，往上一律只认能力。
 * 任务调度、额度、资料库、管理后台、前端都只跟本文件里的类型打交道，
 * 接第二家的工作量就等于「实现一遍 Provider 接口」，其余不动。
 *
 * 定这个接口时反复权衡的一点：要不要把供应商的原始状态、原始错误码透上来。
 * 结论是不透。一旦透上去，调度层就会开始 if (provider === 'x') 判断，
 * 抽象层就名存实亡了。所以状态和错误都必须在适配器里归一，
 * 原始响应只作为 raw 挂着供排查，任何调度逻辑都不许读它。
 */

export type Capability =
  | 'image'
  | 'video'
  | 'avatar'
  | 'tts'
  | 'voice_clone'
  | 'lipsync'
  | 'person'

export const CAPABILITIES: Capability[] = [
  'image',
  'video',
  'avatar',
  'tts',
  'voice_clone',
  'lipsync',
  'person',
]

/**
 * 归一后的任务状态。
 *
 * failed 与 fatal 的区别只有一个：重试有没有意义。
 * 各家供应商对这件事的表达五花八门（有的给状态码，有的给字符串，
 * 有的把「素材不存在」塞进服务端错误码里），全部由适配器负责判断，
 * 调度层只看这两个字。
 */
export type TaskStatus =
  | 'queued'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'fatal'
  | 'cancelled'

/**
 * 归一后的错误类型（验收第 11 条）。
 *
 * 界面上要能区分「等一会再来」和「你得改点什么」，所以不能只有一个「生成失败」。
 * 新增供应商如果冒出这里覆盖不了的情况，宁可加一个枚举值，
 * 也不要塞进 provider_error 了事——那等于把问题又还给用户。
 */
export type ErrorCode =
  | 'auth_failed'          // 凭据无效或过期
  | 'rate_limited'         // 触发限流，退避后可重试
  | 'timeout'              // 超时
  | 'bad_param'            // 参数不合法，改参数才有意义
  | 'missing_resource'     // 引用的素材、音色、数字人不存在
  | 'content_rejected'     // 内容审核未通过
  | 'insufficient_balance' // 供应商侧余额不足
  | 'provider_error'       // 对方服务异常，可重试
  | 'unknown'

/** 哪些错误重试还有机会 */
export const RETRYABLE_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'rate_limited',
  'timeout',
  'provider_error',
])

export class ProviderError extends Error {
  readonly code: ErrorCode
  readonly traceId?: string
  /** 供应商原样返回的内容，只用于排查和落库，不参与任何判断 */
  readonly raw?: unknown

  constructor(code: ErrorCode, message: string, opts: { traceId?: string; raw?: unknown } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.traceId = opts.traceId
    this.raw = opts.raw
  }

  get retryable(): boolean {
    return RETRYABLE_ERRORS.has(this.code)
  }
}

/** 一次生成产出的一个文件。服务端负责在链接失效前把它转存到我方对象存储。 */
export interface Output {
  kind: 'image' | 'video' | 'audio' | 'text'
  /** 供应商的临时地址。只用来下载，不下发给浏览器。 */
  url: string
  mime?: string
  /** 文本类能力直接给正文，没有可下载的文件 */
  text?: string
  meta?: Record<string, unknown>
}

/**
 * 实际用量，用于按量计价。
 *
 * 视频按秒计费，图片按张，所以换算表里的 per_unit 规则要乘上这个数。
 * 供应商不给用量的，适配器返回 undefined，按一口价结算。
 */
export interface Usage {
  unit: 'second' | 'count'
  amount: number
}

/**
 * 提交入参。
 *
 * modelCode 单独列出来而不是塞进 params：它是任务的一等字段（要落库、要计价、
 * 要在管理后台按模型统计），但各家把它叫什么、放在请求体哪一层各不相同。
 * 所以调度层只管交出「用哪个模型」，字段名由适配器自己拼。
 */
export interface SubmitInput {
  capability: Capability
  modelCode?: string | null
  params: Record<string, unknown>
}

export interface SubmitResult {
  providerTaskId: string
  traceId?: string
  raw?: unknown
}

export interface PollResult {
  status: TaskStatus
  /** 0 到 100 */
  progress: number
  outputs: Output[]
  /**
   * 训练类能力（声音克隆、定制数字人）产出的不是文件而是一个可引用的 id。
   * 它要存进资料库当作素材用，但没有可下载的内容，所以跟 outputs 分开。
   */
  resourceId?: string
  error?: { code: ErrorCode; message: string }
  usage?: Usage
  traceId?: string
  raw?: unknown
}

/** 上传素材的结果。各家引用素材的方式不同，能给 id 的给 id，只能给地址的给地址。 */
/**
 * 素材的用途。决定平台把它放进哪个桶，以及允许用在哪些下游能力上。
 * 跟文件类型是两回事：同样是视频，做背景和做口型驱动的源，用途不同。
 */
export type AssetPurpose =
  | 'reference'        // AI 创作的参考图
  | 'background'       // 数字人合成的背景
  | 'avatar_training'  // 定制数字人的训练素材
  | 'lipsync_source'   // 口型驱动的源视频
  | 'audio'            // 音频，用于口型驱动或声音克隆

export interface UploadResult {
  /** 这份文件按什么用途上传的。存进资产记录，下次用途不同时要重传。 */
  purpose?: AssetPurpose
  /** 供应商侧的文件 id，后续提交任务时引用 */
  fileId?: string
  /** 供应商侧可访问的地址 */
  url?: string
  /** 该引用的失效时间。平台普遍会清理上传素材，到点要标记失效并重传。 */
  expiresAt?: Date
  raw?: unknown
}

/** 平台账单上这一笔的实际扣费 */
export interface ActualCost {
  currency: string
  amount: number
  /** 平台给的消耗类型描述，记进账本便于核对 */
  note?: string
}

export interface BalanceEntry {
  /** 供应商自家的货币名，例如 bean、magic */
  currency: string
  amount: number
  raw?: unknown
}

/**
 * 模型定义。前端的模型列表从服务端读（验收第 13 条），
 * 新增或停用模型只改数据、不发前端版本。
 *
 * 字段描述沿用前端原有的 FieldSpec 形状，这样前端的动态表单不用重写。
 */
export interface ProviderModel {
  code: string
  label: string
  capability: Capability
  vendor?: string
  tags?: string[]
  enabled: boolean
  /** 表单字段定义，结构与前端 FieldSpec 一致 */
  fields: unknown[]
}

/** 适配器执行时拿到的上下文。凭据只在这里出现，绝不外流。 */
export interface ProviderContext {
  credentials: Record<string, unknown>
  /** 记一条对外调用日志，落 api_logs */
  log: (entry: {
    method: string
    path: string
    durationMs: number
    ok: boolean
    code?: number
    msg?: string
    traceId?: string
  }) => void
  signal?: AbortSignal
}

/**
 * 一家供应商的适配器。
 *
 * 接新的一家只需要实现这个接口，再往 providers 表和 cost_rules 表插数据。
 * 账号、权限、任务调度、额度、资料库和前端主体逻辑都不需要改动。
 */
export interface Provider {
  readonly id: string
  readonly label: string
  readonly capabilities: readonly Capability[]
  /** 这家用哪几种货币计费，对应 cost_rules.currency */
  readonly currencies: readonly string[]

  /** 提交一个任务，返回供应商侧的任务 id */
  submit(ctx: ProviderContext, input: SubmitInput): Promise<SubmitResult>

  /** 查询任务进展 */
  poll(ctx: ProviderContext, capability: Capability, providerTaskId: string): Promise<PollResult>

  /** 取消任务。不支持的能力可以不实现。 */
  cancel?(ctx: ProviderContext, capability: Capability, providerTaskId: string): Promise<void>

  /**
   * 上传素材。签名在服务端完成，浏览器不接触凭据。
   *
   * purpose 是「这个文件将来用来干什么」，不是文件类型。
   * 平台按用途分桶，传错桶的文件在下游会被当成不存在——
   * 一段视频当合成背景传和当口型驱动源传，落的桶不一样，
   * 用错了报出来是「文件还未完成上传」，跟真实原因差很远。
   */
  upload(
    ctx: ProviderContext,
    file: {
      name: string
      mime: string
      size: number
      body: AsyncIterable<Uint8Array> | Buffer
      purpose?: AssetPurpose
    },
  ): Promise<UploadResult>

  /** 拉取余额，用于定时对账 */
  balance(ctx: ProviderContext): Promise<BalanceEntry[]>

  /**
   * 查一笔任务的实际扣费。
   *
   * 有这个才能按实际结算而不是按价目表估。平台的公开价目表是挂牌价，
   * 实测跟账单对不上：同一个 seedream 5.0 Pro 目录标 8、实际扣 20；
   * seedance 4 秒 720P 按目录算 120、实际扣 180。四笔里只对上两笔。
   * 挂牌价拿来做提交时的预扣够用，结算必须以账单为准。
   *
   * 返回 null 表示平台还没出账，调用方退回按估算记并标待对账。
   * 不实现这个方法的供应商一律按估算结算。
   */
  actualCost?(ctx: ProviderContext, providerTaskId: string, at: Date): Promise<ActualCost | null>

  /** 可用模型 */
  models(ctx: ProviderContext): Promise<ProviderModel[]>
}

/** 适配器注册表。接新家就在这里加一行。 */
const REGISTRY = new Map<string, Provider>()

export function registerProvider(p: Provider): void {
  if (REGISTRY.has(p.id)) throw new Error(`供应商 ${p.id} 重复注册`)
  REGISTRY.set(p.id, p)
}

export function getProvider(id: string): Provider {
  const p = REGISTRY.get(id)
  if (!p) throw new Error(`未知的供应商 ${id}`)
  return p
}

export function listProviders(): Provider[] {
  return [...REGISTRY.values()]
}

/** 支持某项能力的所有供应商。以后做负载分流时按这个挑。 */
export function providersFor(capability: Capability): Provider[] {
  return listProviders().filter((p) => p.capabilities.includes(capability))
}
