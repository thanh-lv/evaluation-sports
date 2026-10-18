# Glossary: English ↔ Vietnamese terminology

Terminology for app copy, rubric text, the camera guide and store listings. The base list is DESIGN.md §10.2 (v1.1); sport terms come from `docs/research/sport-rubric.md` §5.

**Every row is marked (?) – pending coach review.** A native Vietnamese coach reviews the whole table at M17 (DESIGN.md §12). When a term is approved, replace (?) with ✓ here and set `"reviewed": true` for the matching entry in `supabase/functions/_shared/rubric/glossary.json` (column "Key"). The JSON file is what the app and server read; this page is the human-readable reference and adds terms that only appear in docs and copy.

## 1. Results and scores

| EN | VI | Key | Status |
|---|---|---|---|
| Overall score | Điểm tổng | `overall_score` | (?) |
| Stance & Balance | Tư thế & Thăng bằng | `stance` | (?) |
| Footwork | Di chuyển (bộ pháp) | `footwork` | (?) |
| Swing mechanics | Kỹ thuật vung vợt | `swing` | (?) |
| Contact point (badminton) | Điểm chạm cầu | `contact_badminton` | (?) |
| Contact point (pickleball) | Điểm chạm bóng | `contact_pickleball` | (?) |
| Follow-through | Kết thúc động tác | `follow` | (?) |
| Recovery | Về vị trí (hồi vị) | `recovery` | (?) |
| Strengths | Điểm mạnh | `strengths` | (?) |
| Weaknesses | Cần cải thiện | `weaknesses` | (?) |
| Fix this first | Sửa điều này trước | `fix_first` | (?) |
| Drill | Bài tập | `drill` | (?) |
| Plan (up to 3 priorities) | Kế hoạch tập | — | (?) |
| Cue | Mẹo ngắn | — | (?) |
| Evidence | Dấu hiệu từ video | — | (?) |
| Details (degrees, values) | Chi tiết | — | (?) |
| Not enough data | Chưa đủ dữ liệu | `not_enough_data` | (?) |
| Can't assess from this video | Không đánh giá được từ video | — | (?) |
| Partial result (no credit used) | Chưa đủ dữ liệu — không tính lượt | — | (?) |
| Beta (score label) | beta | — | (?) |
| AI-generated feedback, may be inaccurate | Nhận xét do AI tạo, có thể chưa chính xác | `ai_generated` | (?) |
| Not medical advice. Stop if it hurts. | Không phải lời khuyên y tế. Dừng tập nếu đau. | — | (?) |
| Beginner / Improving / Intermediate / Advanced | Mới bắt đầu / Đang tiến bộ / Trung cấp / Nâng cao | `level_beginner` … `level_advanced` | (?) |

## 2. Badminton

| EN | VI | Key | Status |
|---|---|---|---|
| Forehand overhead clear | Phông cầu thuận tay | `clear` | (?) |
| Smash | Đập cầu | `smash` | (?) |
| Low backhand serve | Giao cầu thấp trái tay | `low_serve` | (?) |
| High (long) serve | Giao cầu cao sâu | `high_serve` | (?) |
| Net shot | Bỏ nhỏ trên lưới | `net_shot` | (?) |
| Lift | Vẩy cầu | `lift` | (?) |
| Ready stance | Tư thế chuẩn bị | `ready_stance` | (?) |
| Split step | Bật nhún (split step) | `split_step` | (?) |
| Lunge | Bước lunge | `lunge` | (?) |
| Backswing | Lấy đà | `backswing` | (?) |
| Weight transfer | Chuyển trọng tâm | `weight_transfer` | (?) |
| Side-on turn | Xoay người nghiêng | — | (?) |
| Non-racket arm | Tay không cầm vợt | — | (?) |
| Racket arm / racket hand | Tay cầm vợt | — | (?) |
| Highest point (contact) | Điểm cao nhất | — | (?) |
| Base (center of the court) | Vị trí trung tâm | — | (?) |
| Rear court / front court | Cuối sân / trên lưới | — | (?) |
| Shuttle | Quả cầu | — | (?) |

## 3. Pickleball

| EN | VI | Key | Status |
|---|---|---|---|
| Serve | Giao bóng | `serve_pb` | (?) |
| Return of serve | Trả giao bóng | `return` | (?) |
| Dink | Dink | `dink` | (?) |
| Third-shot drop | Drop cú thứ ba | `third_shot_drop` | (?) |
| Drive | Drive | `drive` | (?) |
| Reset | Reset | `reset` | (?) |
| Volley | Vô lê | `volley` | (?) |
| Kitchen (non-volley zone) | Kitchen (vùng cấm vô lê) | `kitchen` | (?) |
| Kitchen line | Vạch kitchen | — | (?) |
| Two-bounce rule | Luật hai lần nảy | `two_bounce` | (?) |
| Paddle | Vợt | — | (?) |
| Ready position | Tư thế sẵn sàng | — | (?) |
| Baseline / sideline | Vạch cuối sân / biên dọc | — | (?) |

Dink, drive and reset stay in English, as Vietnamese players use them. Do not use "Bếp" for the kitchen in app copy (v1.1 decision).

## 4. Body parts

| EN | VI | Status |
|---|---|---|
| Shoulder / elbow / wrist | Vai / khuỷu tay / cổ tay | (?) |
| Forearm / arm | Cẳng tay / cánh tay | (?) |
| Hip / torso / back | Hông / thân người / lưng | (?) |
| Knee / ankle / foot | Đầu gối / mắt cá chân / bàn chân | (?) |
| Ball of the foot | Mũi bàn chân | (?) |
| Bend the knees | Khuỵu gối | (?) |

## 5. App and product terms

| EN | VI | Status |
|---|---|---|
| Analyze a stroke | Phân tích cú đánh | (?) |
| Analysis | Phân tích | (?) |
| Advanced analysis (Sonnet route, `standard`) | Phân tích nâng cao | (?) |
| Basic analysis (Haiku route, `basic`) | Phân tích cơ bản | (?) |
| Free first advanced analysis | Phân tích nâng cao miễn phí lần đầu | (?) |
| Credit (one analysis) | Lượt | (?) |
| "1 of 2 left this month" | Còn 1/2 lượt tháng này | (?) |
| "New credits on 12/11" | Lượt mới vào 12/11 | (?) |
| Free trial (7 days) | Dùng thử 7 ngày | (?) |
| Premium (subscription) | Premium (gói đăng ký) | (?) |
| Unlock Premium | Mở khóa Premium | (?) |
| Restore purchases | Khôi phục giao dịch mua | (?) |
| Save history & use on other devices | Lưu lịch sử & dùng trên thiết bị khác | (?) |
| Camera guide | Hướng dẫn đặt máy quay | (?) |
| Side / behind / back-corner diagonal / front view | Góc bên hông / góc phía sau / góc chéo sau / góc phía trước | (?) |
| Key frame | Khung hình chính | (?) |
| Pose data | Dữ liệu tư thế | (?) |
| Skeleton overlay | Khung xương | (?) |
| Confirm strokes | Xác nhận cú đánh | (?) |
| Me / someone else (subject) | Tôi / Người khác | (?) |
| Keep the app open | Hãy giữ ứng dụng mở | (?) |
| Reading video / detecting pose / analyzing movement | Đọc video / Nhận diện tư thế / Phân tích chuyển động | (?) |
| The AI coach is reviewing | HLV AI đang nhận xét | (?) |
| Remind me in 7 days | Nhắc tôi quay lại sau 7 ngày | (?) |
| Ask a friend to feed you | Nhờ bạn đánh cầu/bóng cho bạn | (?) |
| Rules tip | Mẹo luật | (?) |
| Feedback was written in English | Nhận xét được viết bằng tiếng Anh | (?) |

## 6. Copy style

- Address the user as **"bạn"**. Cues are short imperatives (≤ 8 words), e.g. "Giơ vợt lên trước ngực."
- Fault cards follow **Vấn đề → Cách sửa → Bài tập**.
- Write "chưa đến", not "chưa tới".
- Avoid literal calques (for example "theo-xuyên" for follow-through).
- English copy uses **US spelling** ("Analyze", "color").
- **Never write:** "chuẩn như HLV", "phòng chấn thương" (or "injury prevention"), any DUPR rating, or a club "trình" level. No diagnoses or medical terms; injury notes end with "nếu đau, hãy hỏi HLV/chuyên gia".

## 7. Changes from v1.0

| EN | v1.0 VI | v1.1 VI |
|---|---|---|
| Follow-through | Động tác vung theo | Kết thúc động tác |
| Recovery | Hồi vị | Về vị trí (hồi vị) |
| Kitchen (NVZ) | Bếp (vùng cấm vô-lê) | Kitchen (vùng cấm vô lê) |
| Volley | Vô-lê | Vô lê |
