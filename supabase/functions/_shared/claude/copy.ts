/**
 * Fixed server copy used when model text is missing or filtered (VI copy awaits the coach review, M17).
 */
import type { LocalizedText } from '../contracts/common.ts';

export const SEE_PROFESSIONAL_NOTE: LocalizedText = {
  vi: 'Nếu thấy đau hoặc khó chịu khi tập, hãy dừng lại và hỏi HLV hoặc chuyên gia.',
  en: 'If anything hurts or feels uncomfortable while training, stop and ask a coach or professional.',
};

export const GENERIC_SUMMARY: LocalizedText = {
  vi: 'Cảm ơn bạn đã gửi video. Hãy tập trung vào điểm cần sửa đầu tiên và quay lại video sau vài buổi tập.',
  en: 'Thanks for sending your clip. Focus on the first thing to fix, then film again after a few sessions.',
};

export const GENERIC_WHY: LocalizedText = {
  vi: 'Sửa điểm này giúp cú đánh của bạn ổn định và hiệu quả hơn.',
  en: 'Fixing this makes your stroke more consistent and effective.',
};

export const REJECTED_SUMMARY: LocalizedText = {
  vi: 'Video này chưa phân tích được. Hãy xem gợi ý quay lại video bên dưới và thử lại.',
  en: 'We could not analyse this clip. Check the filming tips below and try again.',
};
