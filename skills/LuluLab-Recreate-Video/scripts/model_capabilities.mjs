export const LOCAL_CLI_REQUIRED_MODEL_IDS={'seedance-2-fast':'seedance2.0fast_vip','seedance-2-mini':'seedance2.0mini_vip'};
export const MODEL_CAPABILITIES={
 'seedance-2-mini':{dreaminaId:'seedance2.0mini_vip',xiaoyunqueId:'seedance2.0mini_vip',minDuration:4,maxDuration:15,resolutions:['720p'],maxImages:9},
 'seedance-2-fast':{dreaminaId:'seedance2.0fast_vip',xiaoyunqueId:'seedance2.0fast_vip',minDuration:4,maxDuration:15,resolutions:['720p'],maxImages:9},
 'seedance-2-fast-vip':{dreaminaId:'seedance2.0fast_vip',minDuration:4,maxDuration:15,resolutions:['720p'],maxImages:9},
 'seedance-2':{dreaminaId:'seedance2.0_vip',xiaoyunqueId:'seedance2.0_vip',minDuration:4,maxDuration:15,resolutions:['720p'],maxImages:9},
 'seedance-2-vip':{dreaminaId:'seedance2.0_vip',minDuration:4,maxDuration:15,resolutions:['720p','1080p','4k'],maxImages:9},
 'seedance-2-5':{dreaminaId:'seedance2.5',xiaoyunqueId:'seedance2.5',minDuration:4,maxDuration:30,resolutions:['720p'],maxImages:9,provisionalDreamina:true},
 'minimax-h3':{minDuration:5,maxDuration:15,resolutions:['720p'],maxImages:9},
 'wan-3':{minDuration:5,maxDuration:30,resolutions:['720p'],maxImages:9},
 'google-omni':{minDuration:5,maxDuration:20,resolutions:['720p'],maxImages:9},
};
const aliases={'seedance 2 mini':'seedance-2-mini','seedance 2 fast':'seedance-2-fast','seedance 2 fast vip':'seedance-2-fast-vip','seedance2fast vip':'seedance-2-fast-vip','seedance2 fast vip':'seedance-2-fast-vip','seedance 2':'seedance-2','seedance 2 vip':'seedance-2-vip','seedance 2.5':'seedance-2-5','seedance 2 5':'seedance-2-5','minimax h3':'minimax-h3','wan 3':'wan-3','wan 3.0':'wan-3','omini':'google-omni','omni':'google-omni','google omni':'google-omni'};
export function normalizeModel(value){const raw=String(value).trim();return aliases[raw.toLowerCase().replace(/[_-]/g,' ').replace(/\s+/g,' ').trim()]||raw;}
export function capability(model){return MODEL_CAPABILITIES[normalizeModel(model)]??null;}
export function validateGeneration(model,duration,resolution='720p'){const id=normalizeModel(model),limits=capability(id);if(!limits)throw new Error(`不支持的视频模型：${id}。`);const numeric=Number(duration);if(!Number.isFinite(numeric)||!Number.isInteger(numeric))throw new Error(`${id} Segment 时长必须是整数秒。`);if(numeric<limits.minDuration||numeric>limits.maxDuration)throw new Error(`${id} Segment 时长必须是 ${limits.minDuration}-${limits.maxDuration} 秒。`);if(!limits.resolutions.includes(resolution))throw new Error(`${id} 不支持 ${resolution}；允许分辨率：${limits.resolutions.join('、')}。`);return {model:id,duration:numeric,resolution,...limits};}
export function minimumSegmentCount(model,totalDuration){const limits=capability(model);if(!limits)throw new Error(`不支持的视频模型：${normalizeModel(model)}。`);return Math.max(1,Math.floor((Math.trunc(Number(totalDuration))+limits.maxDuration-1)/limits.maxDuration));}
