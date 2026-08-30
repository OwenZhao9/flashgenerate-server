/**
 * 我们的模型编码 → 平台价格目录里的条目。
 *
 * 为什么需要这张表：两边的 model_code 根本不是一套。
 * 提交任务用的是 doubao-seedream5.0-pro、tx_kling-v3-0-text2video 这种，
 * 价格目录里写的是 doubao-seedream-5.0 Pro、Kling3.0。没有共用的键。
 *
 * 为什么不做模糊匹配：这里算的是钱。名字凑近了就当成一条，
 * 猜错的后果是静默少扣——系统以为花了 40 点，实际烧掉 350 蝉豆，
 * 而且要等到月底对账才发现。所以宁可映射不上直接报出来，
 * 也不要用一个看起来差不多的价把它糊过去。
 *
 * confirmed 为 false 的是我按名字推断、还没跟平台核实的。
 * 同步时这些会照常生效，但会一并列进「待确认」里提醒人去核。
 */

import type { Capability } from '../types.ts'

export interface PriceAlias {
  /** 我们提交任务时用的 model_code */
  modelCode: string
  capability: Capability
  /** 价格目录里的 item_code */
  item: string
  /** 目录里的 model_code。留空表示该条目只有一行价，不按模型分 */
  catalogModel?: string
  /**
   * 输入类型。目录里同一个模型会按「文/图生视频」「视频生视频」分别标价，
   * 我们这几个模型都是文生或图生，所以固定取前者。
   */
  variant?: string
  /** 已跟平台核实过 */
  confirmed: boolean
  /** 没核实的话，记下判断依据，方便下一个人复核 */
  note?: string
}

export const CHANJING_PRICE_ALIASES: PriceAlias[] = [
  // 图片。目录里 item_code 是 text_to_image。
  {
    modelCode: 'doubao-seedream5.0-pro',
    capability: 'image',
    item: 'text_to_image',
    catalogModel: 'doubao-seedream-5.0 Pro',
    confirmed: true,
  },
  {
    modelCode: 'doubao-seedream5.0-lite',
    capability: 'image',
    item: 'text_to_image',
    catalogModel: 'doubao-seedream-5.0 Lite',
    confirmed: true,
  },
  {
    modelCode: 'image2_medium',
    capability: 'image',
    item: 'text_to_image',
    catalogModel: 'GPT-Image2-medium',
    confirmed: false,
    note: '按名字推断：我们叫 image2_medium，目录里只有 GPT-Image2-medium 带 Image2。价差很大（40/60 蝉豆），务必核实',
  },
  {
    modelCode: 'gemini-3-pro-image',
    capability: 'image',
    item: 'text_to_image',
    catalogModel: 'NanoBanana Pro',
    confirmed: false,
    note: 'NanoBanana 是 Google 图像模型的代号，目录里没有 gemini 字样的条目。30/60 蝉豆，务必核实',
  },

  // 视频。目录里 item_code 是 video_generation。
  {
    modelCode: 'tx_kling-v3-0-text2video',
    capability: 'video',
    item: 'video_generation',
    catalogModel: 'Kling3.0',
    confirmed: true,
  },
  {
    modelCode: 'tx_kling-v3-0-turbo-image2video',
    capability: 'video',
    item: 'video_generation',
    catalogModel: 'KlingV3.0 turbo',
    confirmed: true,
  },
  {
    modelCode: 'kling2.5',
    capability: 'video',
    item: 'video_generation',
    catalogModel: 'Kling2.5',
    confirmed: true,
  },
  {
    modelCode: 'seedance-2.0-lite-wetoken',
    capability: 'video',
    item: 'video_generation',
    catalogModel: 'doubao-seedance-2.0',
    variant: '文/图生视频',
    confirmed: false,
    note: '目录里同时有 doubao-seedance-2.0 和 seedance 2.0mini，编码里的 lite 两边都对得上。取前者，两者 720P 差一倍（30 vs 15 蝉豆），务必核实',
  },
  {
    modelCode: 'seedance-fast-2.0-lite-wetoken',
    capability: 'video',
    item: 'video_generation',
    catalogModel: 'doubao-seedance-2.0fast',
    variant: '文/图生视频',
    confirmed: false,
    note: '同上，取 fast 那一支',
  },

  // 下面几项目录里不按模型分，一个条目一个价。
  {
    modelCode: '',
    capability: 'avatar',
    item: 'video_synthesis',
    catalogModel: 'normal',
    confirmed: false,
    note: '数字人合成按唇形驱动等级计价（普通 1 / 高级 2 / 卡通 3 蝉豆每秒）。我们提交时没有这个参数，暂按普通',
  },
  {
    modelCode: '',
    capability: 'tts',
    item: 'audio_synthesis',
    catalogModel: 'cicada3.0',
    confirmed: false,
    note: '语音合成按音色模型计价（0.06 ~ 0.2 蝉豆每秒）。提交参数里没带模型，暂按 cicada3.0',
  },
  {
    modelCode: '',
    capability: 'voice_clone',
    item: 'custom_voice_digital_person',
    confirmed: true,
    note: '定制音色与定制数字人同一个条目，80 蝉豆一次',
  },
  {
    modelCode: '',
    capability: 'person',
    item: 'custom_voice_digital_person',
    confirmed: true,
  },
  {
    modelCode: '',
    capability: 'lipsync',
    item: 'lip_sync_synthesis',
    catalogModel: 'normal',
    confirmed: false,
    note: '对口型是基础费 80 蝉豆 + 按秒 1~2 蝉豆两段式。基础费由同步单独处理，这里指按秒那部分，暂按普通唇形',
  },
]

/** 对口型的基础费在目录里是同一条目下 model_code 为 base 的那一行 */
export const LIPSYNC_BASE_MODEL = 'base'
