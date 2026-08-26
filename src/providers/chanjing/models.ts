/**
 * 模型注册表。
 *
 * 跟前端那份的区别：label、placeholder、hint 存的是中英两版的成品文案，不是词典键。
 * 验收第 13 条要求「后续新增或停用模型时不需要重新发布前端」，
 * 如果这里存的是词典键，加个新模型就得往前端词典里补词条、再发一次版，
 * 那一条就名存实亡了。所以文案跟着数据走。
 *
 * 图片和视频这二十余个模型共用 ai_creation 的同一组接口，靠 model_code 与
 * creation_type 区分，所以是配置驱动表单，不为单个模型写页面。新增只加一条。
 */

import type { Capability, ProviderModel } from '../types.ts'

export interface Text {
  zh: string
  en: string
}

const t = (zh: string, en: string): Text => ({ zh, en })

// 字段结构与前端 FieldSpec 一一对应，前端的动态表单不用改。
type Field =
  | { key: string; type: 'textarea' | 'text'; label: Text; required?: boolean; max?: number; placeholder?: Text }
  | { key: string; type: 'number'; label: Text; required?: boolean; min?: number; max?: number; default?: number }
  | { key: string; type: 'select'; label: Text; required?: boolean; options: Array<string | number>; default?: string | number }
  | { key: string; type: 'switch'; label: Text; default?: boolean }
  | {
      key: string
      type: 'asset'
      label: Text
      assetType: 'image' | 'video' | 'audio'
      required?: boolean
      max?: number
      maxSizeMB?: number
      /** 提交时的取值形状，各模型对参考素材的要求不同 */
      emit?: 'urls' | 'url' | 'resources'
      hint?: Text
    }

const ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '21:9']
const KLING_RATIOS = ['auto', '16:9', '1:1', '9:16']
const SEEDANCE_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']
const CLARITY = [720, 1080, '2K', '4K']
const D_5_15 = [5, 6, 8, 10, 12, 15]
const D_4_15 = [4, 5, 6, 8, 10, 12, 15]

function prompt(placeholder: Text): Field {
  return {
    key: 'ref_prompt',
    type: 'textarea',
    label: t('提示词', 'Prompt'),
    required: true,
    max: 1500,
    placeholder,
  }
}

function imageFields(): Field[] {
  return [
    prompt(
      t(
        '描述你想要的画面，例如：高级感产品海报，柔和布光，真实材质，细节清晰',
        'Describe the image you want, e.g. a premium product poster, soft lighting, realistic materials, crisp detail',
      ),
    ),
    {
      key: 'ref_img_url',
      type: 'asset',
      label: t('参考图', 'Reference images'),
      assetType: 'image',
      max: 4,
      maxSizeMB: 5,
      emit: 'urls',
    },
    { key: 'aspect_ratio', type: 'select', label: t('画幅', 'Aspect ratio'), required: true, options: ASPECT_RATIOS, default: '9:16' },
    { key: 'clarity', type: 'select', label: t('清晰度', 'Resolution'), options: [1024, 2048], default: 1024 },
    { key: 'number_of_images', type: 'number', label: t('生成数量', 'Number of images'), required: true, min: 1, max: 4, default: 1 },
  ]
}

/**
 * 视频模型的公共尾部字段。
 * video_duration 全部必传，缺了直接判参数错误——这条曾经让五个视频模型全军覆没。
 * 各模型的取值范围并不一样，Kling 2.5 只接受 5 或 10，不是区间。
 */
function tail(ratios: string[], durations: number[]): Field[] {
  return [
    { key: 'aspect_ratio', type: 'select', label: t('画幅', 'Aspect ratio'), required: true, options: ratios, default: ratios.includes('16:9') ? '16:9' : ratios[0]! },
    { key: 'video_duration', type: 'select', label: t('时长（秒）', 'Duration (s)'), required: true, options: durations, default: durations[0]! },
    { key: 'clarity', type: 'select', label: t('清晰度', 'Resolution'), options: CLARITY, default: 1080 },
  ]
}

const refAssets: Field = {
  key: 'ref_resources',
  type: 'asset',
  label: t('参考素材', 'Reference assets'),
  assetType: 'image',
  max: 4,
  maxSizeMB: 5,
  emit: 'resources',
  hint: t('不选就是纯文生视频', 'Leave empty for pure text to video'),
}

interface Spec {
  code: string
  capability: Capability
  label: Text
  vendor: Text
  tags?: Text[]
  fields: Field[]
}

const SPECS: Spec[] = [
  // 图片
  {
    code: 'doubao-seedream5.0-pro',
    capability: 'image',
    label: t('Seedream 5.0 Pro', 'Seedream 5.0 Pro'),
    vendor: t('豆包', 'Doubao'),
    tags: [t('高保真', 'High fidelity'), t('中文文字', 'Chinese text')],
    fields: imageFields(),
  },
  {
    code: 'doubao-seedream5.0-lite',
    capability: 'image',
    label: t('Seedream 5.0 Lite', 'Seedream 5.0 Lite'),
    vendor: t('豆包', 'Doubao'),
    tags: [t('速度快', 'Fast')],
    fields: imageFields(),
  },
  {
    code: 'image2_medium',
    capability: 'image',
    label: t('全能图像模型 2.0', 'All-round Image Model 2.0'),
    vendor: t('通用', 'General'),
    fields: imageFields(),
  },
  {
    code: 'gemini-3-pro-image',
    capability: 'image',
    label: t('全能图像模型', 'All-round Image Model'),
    vendor: t('通用', 'General'),
    fields: imageFields(),
  },

  // 视频
  {
    code: 'seedance-2.0-lite-wetoken',
    capability: 'video',
    label: t('Seedance 2.0（文图生视频）', 'Seedance 2.0 (Text / Image to Video)'),
    vendor: t('豆包', 'Doubao'),
    fields: [
      prompt(t('描述画面与运镜，例如：人物在咖啡馆内抬头微笑，暖色光影，镜头轻推', 'Describe the shot and the camera move, e.g. a person looks up and smiles in a café, warm light, slow push in')),
      refAssets,
      ...tail(SEEDANCE_RATIOS, D_4_15),
    ],
  },
  {
    code: 'seedance-fast-2.0-lite-wetoken',
    capability: 'video',
    label: t('Seedance 2.0 Fast（文图生视频）', 'Seedance 2.0 Fast (Text / Image to Video)'),
    vendor: t('豆包', 'Doubao'),
    tags: [t('速度快', 'Fast')],
    fields: [
      prompt(t('描述画面与运镜，例如：产品在转台上缓慢旋转，柔光棚拍', 'Describe the shot and the camera move, e.g. a product turning slowly on a turntable, soft studio light')),
      refAssets,
      ...tail(SEEDANCE_RATIOS, D_4_15),
    ],
  },
  {
    code: 'tx_kling-v3-0-text2video',
    capability: 'video',
    label: t('Kling 3.0（文生视频）', 'Kling 3.0 (Text to Video)'),
    vendor: t('可灵', 'Kling'),
    fields: [
      prompt(t('未来城市夜景穿梭镜头，光轨拖尾，电影感航拍', 'A flythrough of a futuristic city at night, light trails, cinematic aerial')),
      ...tail(KLING_RATIOS, D_5_15),
    ],
  },
  {
    code: 'tx_kling-v3-0-turbo-image2video',
    capability: 'video',
    label: t('Kling 3.0 Turbo（首帧图生视频）', 'Kling 3.0 Turbo (First Frame to Video)'),
    vendor: t('可灵', 'Kling'),
    tags: [t('速度快', 'Fast')],
    fields: [
      {
        key: 'start_frame',
        type: 'asset',
        label: t('首帧图', 'First frame'),
        assetType: 'image',
        required: true,
        max: 1,
        maxSizeMB: 5,
        emit: 'url',
      },
      prompt(t('描述从这张图开始画面怎么动', 'Describe how this image should start moving')),
      ...tail(KLING_RATIOS, D_5_15),
    ],
  },
  {
    code: 'kling2.5',
    capability: 'video',
    label: t('Kling 2.5', 'Kling 2.5'),
    vendor: t('可灵', 'Kling'),
    fields: [
      prompt(t('描述画面与运镜', 'Describe the shot and the camera move')),
      {
        key: 'start_frame',
        type: 'asset',
        label: t('首帧图', 'First frame'),
        assetType: 'image',
        max: 1,
        maxSizeMB: 5,
        emit: 'url',
        hint: t('可选', 'Optional'),
      },
      {
        key: 'end_frame',
        type: 'asset',
        label: t('尾帧图', 'Last frame'),
        assetType: 'image',
        max: 1,
        maxSizeMB: 5,
        emit: 'url',
        hint: t('可选，配合首帧做过渡', 'Optional — pairs with the first frame to build a transition'),
      },
      // 这个模型只接受 5 或 10，不是区间
      ...tail(KLING_RATIOS, [5, 10]),
    ],
  },
]

export const CHANJING_MODELS: ProviderModel[] = SPECS.map((s) => ({
  code: s.code,
  label: s.label.zh,
  capability: s.capability,
  vendor: s.vendor.zh,
  tags: s.tags?.map((x) => x.zh),
  enabled: true,
  fields: s.fields,
}))

/** 前端要的完整形态，带中英两版 */
export const CHANJING_MODEL_SPECS = SPECS
