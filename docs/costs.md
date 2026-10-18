# Chi phí dự kiến – RacketCoach

> Nghiên cứu và kiểm chứng ngày 18/10/2026. Số có "(ước tính)" là chưa xác minh được, cần kiểm tra lại trước khi chi.

**Tỷ giá dùng: 1 USD = 26,000₫.** Nguồn: Finhay USDVND 25,894.5 (lúc 08:35 ngày 17/10/2026, qua công cụ get_forex_quote); Vietcombank bán ra 26,080 (17/10/2026) [vcb]. Trả bằng thẻ quốc tế thường mất thêm 1–3% (ước tính). "(ước tính)" nghĩa là chưa xác minh được. Giá cập nhật ngày 18/10/2026.

### 1. Chi phí bắt buộc để lên App Store

| Hạng mục | Một lần | Định kỳ | Ghi chú | Nguồn |
|---|---|---|---|---|
| Apple Developer Program (ADP), Individual | 0 | **99 USD/năm = 2,574,000₫**. Giá VND qua app Apple Developer: ~2,299,000₫ (ước tính, Apple không công bố giá VND) | Apple ghi "99 USD, in local currency where available". Đăng ký qua web cần thẻ trừ được USD. Chỉ tổ chức phi lợi nhuận, trường học và cơ quan nhà nước được miễn phí | [adp-buy] [waiver] |
| ADP Organization (nếu lập Công ty TNHH) | D-U-N-S miễn phí | 99 USD/năm | Cần pháp nhân, website và email theo domain. Hộ kinh doanh không phải pháp nhân nên phải đăng ký Individual (ước tính) | [enroll] [duns] |
| Xcode 26+ / iOS 26 SDK | 0 | 0 | Bắt buộc từ 28/4/2026. App phải target iOS 13 trở lên (từ 9/9/2026). Xcode 27 cần macOS Tahoe 26.6+ | [xreq] [xsys] |
| TestFlight, StoreKit 2/IAP, Sign in with Apple | 0 | 0 (đã gồm trong ADP) | TestFlight: 100 internal và 10,000 external tester, mỗi build sống 90 ngày | [adp] [tf] |
| Tài khoản Apple miễn phí | 0 | 0 | Tối đa 3 thiết bị và 10 App ID, profile hết hạn sau 7 ngày. Không dùng được TestFlight hay App Store Connect | [compare] |
| Hoa hồng Apple | 0 | **15%** khi đã vào SBP. Không vào SBP: 30% năm đầu, 15% từ năm thứ 2 | Phải đăng ký SBP. Mức 15% áp dụng từ **15 ngày sau khi hết tháng tài chính** mà đơn được duyệt, nên **đăng ký trước khi bán** | [sbp] [subs] |
| Thuế Apple khấu trừ (dev cá nhân ở VN) | 0 | VAT 5% hoặc 10% (ước tính), PIT 2%, FCT 5% trên phần hoa hồng | Áp dụng từ 21/8/2025. Exhibit B (bản 27/8/2026): Apple thu và nộp thuế cho dev cá nhân VN. Với công ty VN, Apple không nộp VAT hộ, chỉ trừ FCT 5% trên hoa hồng | [taxnews] [exhibit] |
| Tiền thực nhận mỗi thuê bao (cá nhân, có SBP) | – | Gói 79,000₫/tháng: **59,070–61,883₫ (~$2.27–2.38, tức 75–78%)**. Gói 599,000₫/năm: 447,889–469,217₫ (~$17.2–18.1) | Công thức: giá ÷ (1+VAT) × (1 − 15% − 0.75% − 2%). Không có SBP năm đầu: 47,759–50,033₫/tháng. Chưa xác minh 79K và 599K có phải price point sẵn có không | tính từ [subs] [exhibit] |
| Domain .com | – | $10.46 = 271,960₫ nếu đăng ký trước 1/11/2026. **$11.17 = 290,420₫** từ 1/11/2026 | Giá sỉ của Verisign tăng $10.26→$10.97 từ 1/11/2026 04:00 UTC. Có thể gia hạn trước tối đa 10 năm theo giá cũ | [com1] [com2] [verisign] |
| Hosting trang pháp lý | 0 | 0 | Cloudflare Pages gói Free | [cfp] |
| Supabase Pro (khi public launch) | 0 | **$25/tháng = 650,000₫** | Gói Free tự pause sau 1 tuần không hoạt động và không có backup. Pro có backup giữ 7 ngày | [sb-data] [sb-pricing-md] |
| Claude API (trả trước) | Tối thiểu $5 = 130,000₫ (ước tính, chỉ có nguồn bên thứ ba). Nên nạp $20–50 = 520K–1.3M₫ | Theo lượng dùng | Credit hết hạn sau 1 năm và không hoàn tiền | [cl-price] [cl-credits] [cl-min] |
| Email OTP (SMTP riêng) | 0 | 0 với Resend Free (3,000 email/tháng, 100/ngày) | SMTP mặc định của Supabase chỉ gửi tới email team, giới hạn 2 email/giờ. Dùng SMTP riêng thì mặc định 30 email/giờ, chỉnh được (nguồn thứ cấp) | [resend1] [sb-smtp] [sb-smtp2] |
| **Tổng** | **~130K–1.3M₫** | **2,574,000₫/năm (ADP) + ~290K₫/năm (domain) + 650K₫/tháng (Supabase từ lúc launch) + AI theo lượng dùng** | | |

### 2. Thiết bị / máy build

| Kịch bản | Một lần | Định kỳ | Ghi chú | Nguồn |
|---|---|---|---|---|
| **A. Đã có Mac Apple Silicon + iPhone** | 0 | 0 | Cần macOS Tahoe 26.6+ để dùng Xcode 27. iOS 27 có bỏ iPhone 11 không thì các nguồn mâu thuẫn (ước tính), nên ưu tiên iPhone 12 trở lên | [xsys] [9to5] [stuff] |
| **B1. Mac mini M1 16GB/256 cũ (khuyến nghị)** | **~10,900,000₫ (~$419)**. Dải giá 10.4–14.5M₫ (ước tính) | 0 | macOS 27 vẫn hỗ trợ Mac mini M1. Giá Mac cũ tăng theo đợt thiếu RAM 2026 | [macvn] [mac24h-99] [ms24h] [macos27] |
| B1'. Mac mini M1 8GB / M2 8GB cũ | M1 8GB: 7.0–9.0M₫. M2 8GB: 6.99–10.5M₫ (ước tính, chưa kiểm chứng lại; M2 8GB mới bán 15.99M₫) | 0 | 8GB chật cho Xcode 27 kèm Simulator | [2t] [tekcoffee] [ddv-m2] |
| B2. Mac mini mới | **M4 16/256 (hàng tồn): 20,590,000–21,990,000₫ (~$792–846). M6 16/256: 24,490,000–24,999,000₫ (~$942–962)**, giá giáo dục 22,219,000₫ | 0 | Apple ngừng bán bản 256GB từ 22/4–1/5/2026. Giá 13.99–14.99M₫ là giá cũ, không còn đúng | [cps-m4] [techone] [vender] [mr-256] [hh-m6] [pv-m6] [vnr-m6] |
| + iPhone để test | **iPhone 12 128GB cũ: 6.1–7.9M₫ (~$235–304)**. iPhone 11 cũ 5.1–5.4M₫, iPhone 13 cũ 7.5–10.5M₫, iPhone 15 mới 16.5–21.99M₫, iPhone 16 mới 18.7–24.99M₫ (các dòng này ước tính) | 0 | Bắt buộc có máy thật: Simulator không có camera, Vision pose phải chạy trên thiết bị | [xt-cu] [ngoisao] [duchuy] [cps-ip12] |
| C1. Xcode Cloud | 0 | 25 giờ/tháng miễn phí kèm ADP. Thêm 100 giờ: $49.99 = 1.30M₫/tháng | Chỉ làm CI | [xcloud] |
| C2. GitHub Actions macOS | 0 | $0.062/phút = 1,612₫ (giá từ 1/1/2026). Gói Free tương đương ~200 phút macOS/tháng nếu hệ số vẫn là 10× (ước tính) | Chỉ làm CI | [gh-docs] [cicd] |
| C3. Codemagic | 0 | 500 phút M2 miễn phí/tháng (tài khoản cá nhân), sau đó $0.095/phút = 2,470₫. Máy M4: $0.114/phút | Gói free đủ cho CI một người | [codemagic] |
| C4. MacinCloud | 0 | ~$1/giờ, gói tháng $25–29 = 650–754K₫, máy riêng M2 $99 hoặc M4 $124.99 (ước tính, nguồn là trang đối thủ) | Có độ trễ | [greenmini] |
| C5. MacStadium M4.S | 0 | **$149/tháng = 3,874,000₫** (tăng từ $119 cuối 6/2026) | 5.7 tháng thuê bằng giá M4 tồn kho; 6.5 tháng bằng giá M6 | [ms-pricing] |
| C6. AWS EC2 Mac | Tối thiểu 24 giờ: $15.60 (M1, $0.6498/giờ) = 405,600₫; $21.07 (M2, $0.878/giờ) = 547,820₫ | ~$475–641/tháng = 12.35–16.67M₫ | Tính tiền theo thời gian giữ host | [aws-blog] [aws2] |
| **So sánh mua và thuê** | B1 10.9M₫ ≈ 14.5–16.8 tháng thuê MacinCloud, hoặc ≈ 2.8 tháng MacStadium | – | Về lâu dài **B1 rẻ nhất** (ước tính) | tính toán |

### 3. Hạ tầng & AI hàng tháng

**Giả định:**
- Mỗi user free dùng 1 phân tích Sonnet và 1 Haiku mỗi tháng. Kịch bản "chỉ Haiku" là 2 phân tích Haiku. Mỗi user trả phí dùng 6 phân tích Sonnet.
- Mỗi phân tích: 5 frame 768px (448–784 token mỗi frame), 6K token text, 2.5–3.3K token output.
- Ca "tốt": 6K text trúng cache, ảnh 768×432, 2.5K output. Ca "xấu": 6K text ghi cache 5 phút (giá 1.25×), ảnh 768×768, 3.3K output.
- Bảng tính khi **không có thinking**.
- Conversion 3–5%, tất cả mua gói tháng. Thực nhận 59,070–61,883₫ mỗi thuê bao mỗi tháng.

| Đơn giá Claude | Haiku 5.5 | Sonnet 5.5 | Ghi chú | Nguồn |
|---|---|---|---|---|
| $/triệu token: in / out / cache read / ghi cache 5 phút | $0.10 / $0.50 / $0.01 / $0.125 | $2 / $10 / $0.10 / $2.50 | Batch giảm 50% (Haiku $0.05/$0.25, Sonnet $1/$5). Haiku tăng lên $0.50/$2.50 nếu prompt >100K token. Chọn `inference_geo:"us"` thì nhân 1.1× | [cl-price] |
| Token ảnh | 768×432: 448/frame. 768×768: 784/frame | | Công thức ⌈w/28⌉×⌈h/28⌉. Model 4.7 trở lên là tier high-res: ảnh 1920×1080 tốn 2,691 token, nên **phải resize trước khi gửi** | [cl-vision] |
| Thinking | Mặc định bật, effort `medium`. Tắt bằng `disabled` (chỉ ở low/medium/high) | Mặc định bật, effort `high`. **`disabled` trả lỗi 400**, phải dùng `{"type":"between_tools"}` (chỉ ở low/medium/high) | Token thinking tính giá như output: mỗi 1K token thinking thêm $0.01 (260₫) cho Sonnet | [cl-sonnet55] [cl-haiku55] |
| **Chi phí mỗi phân tích** | **$0.00153–0.00279 (40–73₫)** | **$0.0301–0.0558 (782–1,452₫)** | Không bật cache: Haiku $0.00264, Sonnet $0.0528. Output chiếm 59–83% chi phí Sonnet | tính toán |
| Mỗi user free / tháng | Free tier dùng Sonnet: $0.0316–0.0586 (822–1,524₫). Chỉ Haiku: $0.0031–0.0056 (80–145₫) | | | tính toán |
| Mỗi user trả phí / tháng | $0.180–0.335 (4,692–8,711₫), tức 8–15% tiền thực nhận | | | tính toán |

| Hạng mục / tháng | Dev/beta (100 user) | Ra mắt (~1,000 MAU) | Tăng trưởng (~10,000 MAU) | Ghi chú | Nguồn |
|---|---|---|---|---|---|
| Supabase | Free: $0 | Pro: $25 = 650K₫ | Pro $25 = 650K₫. Lên compute Small thêm **+$5 = 130K₫** (Small $15 trừ $10 credit) | Quota Pro: 100K MAU, 8GB disk, 250GB egress, 100GB storage, 2M function invocations. Vượt quota: $0.00325/MAU, $0.09/GB egress | [sb-data] [sb-pricing-md] |
| Storage / egress | Trong gói Free | Trong quota (ước tính) | Egress ~11GB, trong quota (ước tính) | Nên xoá frame sau khi phân tích | tính toán |
| Claude (free tier dùng Sonnet) | $3.6–7.2 = 94–188K₫ | **$36–72 = 0.94–1.88M₫** | **$361–725 = 9.38–18.84M₫** | Phân tích Sonnet cho user free chiếm 73–81% chi phí AI | tính toán |
| Claude (free tier chỉ Haiku) | $0.8–2.2 = 22–57K₫ | $8.4–22.1 = 0.22–0.57M₫ | $84–221 = 2.18–5.73M₫ | Dùng Batch cho user free thì giảm tiếp 50% | tính toán |
| Email OTP | $0 | $0 (Resend Free; giới hạn 100 email/ngày là rủi ro trong ngày launch) | Resend Pro $20 = 520K₫ | | [resend1] |
| Domain (chia tháng) | 24K₫ | 24K₫ | 24K₫ | | [com2] |
| ADP (chia tháng) | 214.5K₫ | 214.5K₫ | 214.5K₫ | | [adp-buy] |
| **Tổng chi (free tier Sonnet)** | **$12.8–16.4 = 0.33–0.43M₫** | **$70–107 = 1.83–2.77M₫** | **$415–779 = 10.8–20.2M₫** | Chưa tính pháp lý và marketing | tính toán |
| **Tổng chi (free tier Haiku)** | $10.0–11.4 = 0.26–0.30M₫ | $43–56 = 1.11–1.46M₫ | $138–275 = 3.59–7.14M₫ | | tính toán |
| Thực nhận @3% | 3 thuê bao → 177–186K₫ (0₫ khi còn ở TestFlight) | 30 → **1.77–1.86M₫** | 300 → **17.7–18.6M₫** | | [subs] [exhibit] |
| Thực nhận @5% | 5 → 295–309K₫ | 50 → **2.95–3.09M₫** | 500 → **29.5–30.9M₫** | | tính toán |
| Lãi/lỗ @3% (Sonnet / Haiku) | −0.24…−0.15M₫ / −0.10…−0.08M₫ | **−0.86…+0.03M₫** / +0.48…+0.75M₫ | −1.1…+7.8M₫ / +12.3…+15.0M₫ | | tính toán |
| Lãi/lỗ @5% (Sonnet) | −0.13…−0.03M₫ | +0.18…+1.19M₫ | +9.3…+19.4M₫ | | tính toán |
| **Conversion hoà vốn, gói tháng (Sonnet / Haiku)** | 5.5–7.5% / 4.3–5.0% | **3.0–4.7% / 1.7–2.1%** | 1.7–3.2% / 0.4–0.6% | Hoà vốn vận hành | tính toán |
| Conversion hoà vốn, gói năm (thực nhận 37.3–39.1K₫/tháng) | – | 4.9–8.0% / 2.8–3.6% | 2.7–5.5% / 0.6–1.0% | Gói năm làm doanh thu mỗi tháng giảm ~37% | tính toán |

### 4. Pháp lý & kinh doanh tại VN

| Hạng mục [mức độ] | Một lần | Định kỳ | Ghi chú | Nguồn |
|---|---|---|---|---|
| Dev cá nhân (Apple Individual) **[MVP: khuyến nghị]** | 0₫ | ADP 2,574,000₫/năm | Không cần D-U-N-S. Apple tự khấu trừ VAT, PIT và FCT | [duns] [exhibit] |
| Hộ kinh doanh **[tuỳ chọn]** | ~100,000₫, tuỳ tỉnh (ước tính) | Kế toán 300K–1M₫/tháng (ước tính) | Trên Apple vẫn là Individual. Doanh thu ≤1 tỷ/năm không chịu VAT/PIT (NĐ 141/2026, hiệu lực 1/1/2026) | [hkd] [nd141-gov] |
| Công ty TNHH 1TV **[tuỳ chọn; nên có trước khi scale hoặc ra quốc tế]** | Lệ phí đăng ký 25,000₫ (giảm 50% đến 31/12/2026; nộp online được miễn theo nguồn thứ cấp). **Phí công bố thông tin 100,000₫** (không được giảm). Trọn gói dịch vụ 3.5–10M₫ (ước tính) | Kế toán 500–800K₫/tháng (0–5 hoá đơn) hoặc 1–1.5M₫ (ước tính) | Cần để có tài khoản Apple Organization. **Cộng thêm trong 6 tháng đầu: ~6.6–16.7M₫ (~$254–642) (ước tính)** | [tt64] [dn-fee] [qd2473] [kta-tl] [kt1] |
| Lệ phí môn bài | 0 | **0 (chấm dứt từ 1/1/2026)** | Khoản 7 Điều 10 NQ 198/2025/QH15; NĐ 362/2025 bãi bỏ NĐ 139/2016 | [monbai] [vneco] [nd362] |
| Chữ ký số [bắt buộc với công ty] | 1,826,000₫/12 tháng hoặc 3,109,000₫/36 tháng (ước tính) | Gia hạn ~1.27M₫/năm (ước tính) | | [cks1] [cks2] |
| Hoá đơn điện tử (công ty) | MISA 450,000₫/300 hoá đơn (ước tính) | Theo gói | Cách xuất hoá đơn cho doanh thu App Store: cần kế toán xác nhận | [meinv] |
| Thuế với cá nhân / hộ kinh doanh | 0 | ≤1 tỷ/năm: 0 VAT/PIT | Apple vẫn khấu trừ PIT 2% và FCT 5%. Có được hoàn hay bù trừ không: cần kế toán xác nhận | [nd141-gov] [taxnews] |
| Thuế với công ty | 0 | CIT 0% nếu tổng doanh thu ≤1 tỷ (NĐ 141/2026). **DNNVV mới thành lập được miễn CIT 3 năm** (NQ 198/2025). Ngoài ra: 15% nếu ≤3 tỷ, 17% nếu 3–50 tỷ (ước tính) | VAT: app subscription có bị xếp là "nội dung số" chịu 10% không thì cần kế toán xác nhận | [nd141-gov] [nq198-cit] [misa-cit] [cv4998] |
| Nhãn hiệu "RacketCoach" **[nên nộp trước 31/12/2026]** | 1 nhóm: ~1.0–1.36M₫ (ước tính, các nguồn lệch nhau). Giảm 50% lệ phí theo TT 64/2025 và miễn lệ phí nộp đơn + cấp văn bằng khi nộp qua VNeID (TT 29/2026) **đều hết hạn 31/12/2026**. 3 nhóm (9, 41, 42): ~2.8–3.0M₫ (ước tính). Qua đại diện SHCN: thêm 2–5M₫/nhóm | Gia hạn 10 năm | | [tm-tvpl] [ipvn] [tm2] [tm-agent] |
| PDPL: DPIA và hồ sơ chuyển dữ liệu ra nước ngoài (Supabase Singapore, Anthropic Mỹ) **[rủi ro cao, cần luật sư trước launch]** | Phí nhà nước: chưa thấy (ước tính 0₫). Tư vấn luật VN 15–60M₫ (ước tính) | Cập nhật 5–15M₫/năm (ước tính) | Luật 91/2025 hiệu lực 1/1/2026. Nộp hồ sơ trong 60 ngày. Hộ kinh doanh và DN siêu nhỏ được miễn; DN nhỏ và startup được tự chọn trong 5 năm (đến ~1/1/2031). **Mất miễn trừ nếu**: xử lý dữ liệu nhạy cảm, cung cấp dịch vụ xử lý dữ liệu, hoặc từ 100,000 chủ thể dữ liệu trở lên. Video cơ thể và pose có thể bị coi là sinh trắc học. Chưa rõ dev cá nhân thuộc nhóm nào. Phạt vi phạm chuyển dữ liệu ra nước ngoài: tới 5% doanh thu năm trước, hoặc tới 3 tỷ₫ nếu không có doanh thu / 5% thấp hơn. Vi phạm khác: tới 3 tỷ₫. Cá nhân bị phạt 1/2 (ước tính). NĐ xử phạt 330/2026: nguồn mâu thuẫn (ước tính) | [pdpl-yp] [pdpl-fine] [pdpl-uc] [pdpl-bw] [pdpl1] [luatvietan] |
| Thông báo app TMĐT **[cần luật sư xác nhận]** | Tự làm 0₫. Thuê dịch vụ 2–5M₫ (ước tính) | Báo cáo định kỳ | Luật 122/2025 và NĐ 248/2026 hiệu lực 1/7/2026. App chỉ bán dịch vụ của mình qua IAP vẫn là vùng xám | [moit1] [moit2] [moit-law] |
| Phân loại độ tuổi riêng cho VN (NĐ 147) | 0 | 0 | Trả lời bảng câu hỏi trong App Store Connect để nhận mức 00+, 12+, 16+ hoặc 18+ | [apple-news] |
| Nhận tiền từ App Store | 0 | 0 | Apple trả trong 45 ngày sau khi hết tháng tài chính. **Ngưỡng chuyển tiền $40 cho VN (đã xác minh)**. Cần dự trữ tiền mặt cho ~2 tháng | [pay] [threshold] |

### 5. Tuỳ chọn (chưa kiểm chứng lại lần này, coi là ước tính trừ chỗ có ghi chú)

| Hạng mục | Một lần | Định kỳ | Ghi chú | Nguồn |
|---|---|---|---|---|
| App icon | $10–30 / **$50–200 (1.3–5.2M₫)** / $500 (ước tính) | – | | [icon1] [icon2] [icon3] |
| Figma | 0 (Starter) | ~$16/editor/tháng = 416K₫ (ước tính) | | [figma] |
| Sentry | 0 (5K lỗi/tháng) | Team $26/tháng = 676K₫ (ước tính) | | [sentry] |
| Supabase: staging / PITR 7 ngày / custom domain | – | Staging chạy local bằng Docker: 0₫. **PITR $100 = 2.6M₫/tháng**. Custom domain $10 = 260K₫/tháng (giá Supabase đã xác minh) | Pro đã có backup 7 ngày | [sb-data] [docker] |
| Domain .app / .vn | .vn: 100K₫ phí đăng ký + phí nhà đăng ký (ước tính) | .app $14.20 = 369,200₫/năm. .vn 350,000₫/năm (ước tính) | | [app] [vn-dom] |
| Thuê coach hiệu chỉnh | 20–40 giờ = 6–40M₫ (ước tính) | 200–500K₫/giờ (ước tính) | Xin đồng ý bằng văn bản của người được quay (PDPL) | [coach] [reclub] |
| Marketing gói nhỏ / gói vừa (3 tháng) | 20–40M₫ / 100–200M₫ (ước tính) | – | | ước tính |
| Tham chiếu quảng cáo | – | TikTok CPM ~$2, Meta CPM $1–4, iOS CPI $0.8–2.5 (ước tính) | | [tiktok] [meta] [af] |
| KOC/KOL | Nano 1–5M₫/video, micro 5–20M₫ (ước tính) | – | | [kol] |
| Tài trợ giải CLB | 3–20M₫/giải (ước tính) | – | | [nhandan] |
| Nhãn hiệu Madrid | 653 CHF phí cơ bản + phí từng nước; ~1,500–3,500 CHF (ước tính) | 10 năm | | [wipo] |

### 6. Tổng kết ngân sách

| Mốc | A (đã có Mac + iPhone) | B (mua Mac + iPhone 12 cũ) | Gồm | Nguồn |
|---|---|---|---|---|
| **Tối thiểu để lên TestFlight** | **2,704,000₫ (~$104)** | **19.7M₫ (~$758)** với M1 16GB cũ. 15.8M₫ (~$608) với Mac 8GB cũ (ước tính). **30.8M₫ (~$1,184)** với M4 tồn kho. 33.8M₫ (~$1,300) với M6 | ADP + Claude $5. Cộng Mac và iPhone 12 6.1M₫ | §1, §2 |
| **Tối thiểu để lên App Store VN (tháng đầu)** | **3.35–4.03M₫ (~$129–155)** | **21.0M₫ (~$809)** với M1 16GB. 17.1M₫ với Mac 8GB. 32.1M₫ với M4. 35.1M₫ với M6 | Cộng Supabase Pro, domain, Claude $5–20 | §1, §3 |
| **6 tháng, bản tiết kiệm** | **~56.8M₫ (~$2,186)** | **~73.8M₫ (~$2,840)** | Bảng dưới | §1–5 |
| **6 tháng, bản đầy đủ** | **~139.3M₫ (~$5,356)** | **~172.2M₫ (~$6,621)** với M6 24.999M₫ + iPhone 12 7.9M₫. Với M4 tồn kho 21.99M₫: 169.1M₫ | Bảng dưới | §1–5 |
| Cộng thêm nếu lập công ty | +6.6–16.7M₫ (ước tính) | Như A | | §4 |
| Tham khảo C (không mua Mac) | 2.7M₫ + iPhone 12 6.1M₫ + MacinCloud 650–754K₫/tháng (ước tính) | – | Mất Previews/Simulator chạy local | §2 |

Giả định 6 tháng: tháng 1–3 làm dev và beta với 100 user; tháng 4 có 100 MAU, tháng 5 có 500, tháng 6 có 1,000; free tier dùng Sonnet.

| Khoản | Tiết kiệm | Đầy đủ | Ghi chú | Nguồn |
|---|---|---|---|---|
| ADP | 2,574,000₫ | 2,574,000₫ | | [adp-buy] |
| Domain .com | 271,960₫ | 290,420₫ | | [com2] |
| Supabase (3 tháng Free + 3 tháng Pro) | 1,950,000₫ | 1,950,000₫ | | [sb-data] |
| Claude API 6 tháng | **$69 = 1.78M₫** | **$138 = 3.58M₫** | Free tier chỉ dùng Haiku thì giảm ~70–77% | §3 |
| Icon | 1.3M₫ | 5.2M₫ | (ước tính) | [icon1] |
| Nhãn hiệu 3 nhóm | 2.8M₫ | 3.0M₫ | (ước tính) | [tm-tvpl] |
| Tư vấn PDPL | 15M₫ | 60M₫ | (ước tính) | [luatvietan] |
| Coach 20 giờ | 6M₫ | 10M₫ | (ước tính) | [coach] |
| Marketing | 20M₫ | 40M₫ | (ước tính) | [tiktok] |
| Dự phòng 10% | 5.17M₫ | 12.66M₫ | | |
| **Tổng A** | **56.8M₫ (~$2,186)** | **139.3M₫ (~$5,356)** | | |
| Phần cứng B | +17.0M₫ (M1 16GB 10.9M₫ + iPhone 12 6.1M₫) | +32.9M₫ (M6 24.999M₫ + iPhone 12 7.9M₫) | | [macvn] [hh-m6] [xt-cu] |
| **Tổng B** | **73.8M₫ (~$2,840)** | **172.2M₫ (~$6,621)** | | |

**Những điểm quyết định chi phí nhiều nhất:**
1. **Model cho free tier.** Ở 1K MAU, nếu free tier dùng Sonnet thì cần conversion 3.0–4.7% mới hoà vốn; nếu chỉ dùng Haiku thì 1.7–2.1%.
2. **Thinking.** Với Sonnet 5.5, `disabled` trả lỗi 400: phải dùng `between_tools` hoặc effort `low`. Với Haiku 5.5, `disabled` dùng được ở effort low–high. Nếu để mặc định (Sonnet bật thinking, effort high) thì chi phí sẽ vượt bảng trên.
3. **Resize frame về 768px** trước khi gửi.
4. **Đăng ký SBP trước khi bán.**
5. **Mua domain trước 1/11/2026 và nộp nhãn hiệu trước 31/12/2026.**
6. **Giá Mac mới đã tăng ~45–65%** so với giá cũ trong bản nháp.
7. **PDPL** là rủi ro pháp lý lớn nhất.

**Ghi chú kiểm chứng**
1. **Tỷ giá:** giữ 26,000. Finhay 25,894.5, VCB bán 26,080.
2. **Link [taxnews] sai:** id qs5bol0 là tin beta iOS 18.2. Đã thay bằng tin thuế ngày 21/8/2025 (id yo2104n5).
   - Đúng: PIT 2% và FCT 5% trên hoa hồng.
   - Exhibit B (bản 27/8/2026): Apple thu và nộp thuế cho dev cá nhân VN, không thu nộp cho công ty VN.
   - Thuế suất VAT cho cá nhân VN: Apple không công bố, vẫn để (ước tính).
3. **Phần Apple:**
   - SBP 15%: đúng. Bổ sung thời điểm bắt đầu áp dụng.
   - Ngưỡng chuyển tiền $40 cho VN: đã xác minh.
   - Xcode 26 bắt buộc từ 28/4/2026; Xcode 27 cần Tahoe 26.6: đúng. Bổ sung yêu cầu target iOS 13 trở lên.
   - macOS 27 vẫn hỗ trợ Mac mini M1.
   - iOS 27 có bỏ iPhone 11 không: nguồn mâu thuẫn.
4. **Giá Mac:**
   - **SAI** giá Mac mini M4 16/256 mới. 13.99–14.99M₫ là giá cũ; hiện 20.59–21.99M₫ và Apple đã ngừng bản 256GB từ 4–5/2026. Đã thêm M6 24.49–24.999M₫.
   - M1 16GB cũ: 9.9M₫ → ~10.9M₫ (ước tính).
   - Phép so sánh với MacStadium: 3.6 tháng → 5.7–6.5 tháng.
5. **Cloud Mac:** Xcode Cloud, Codemagic, giá GitHub $0.062/phút, MacStadium $149, AWS $15.60/$21.07: đúng. MacinCloud và hệ số macOS 10× của GitHub: vẫn ước tính.
6. **Đơn giá Claude:** đúng ($0.10/$0.50/$0.01; $2/$10/$0.10; Batch 50%). Công thức token ảnh đúng.
7. **SAI** phép tính chi phí mỗi phân tích. Bản gốc ngầm tính ~13–15K token đầu vào, thay vì 5 ảnh + 6K text như đề bài. Tính lại:
   - Haiku: $0.0015–0.0028; Sonnet: $0.030–0.056 (đã gồm phí ghi cache 1.25× ở ca xấu).
   - Toàn bộ §3 được tính lại: chi phí AI giảm ~12–22%, ngưỡng hoà vốn thấp hơn.
   - Claude 6 tháng: $89/$156 → $69/$138.
8. **SAI** "tắt thinking" với Sonnet 5.5:
   - `disabled` trả lỗi 400; phải dùng `between_tools` (chỉ ở effort ≤ high).
   - Mặc định của Sonnet 5.5: thinking bật, effort high. Haiku 5.5: mặc định effort medium, `disabled` dùng được ở low–high.
   - Bổ sung cảnh báo: phải resize frame vì đây là tier ảnh high-res.
9. **Supabase:** gói Free và Pro đúng. **Sửa** chi phí nâng compute Small: +$5 ròng (vì có $10 credit), không phải +$15. Bổ sung giới hạn 2 và 30 email/giờ của SMTP.
10. **Domain** $10.46 → $11.17 từ 1/11/2026: đúng (Verisign tăng giá sỉ lên $10.97).
11. **SAI** phí công bố thông tin doanh nghiệp: 100,000₫, không phải 50,000₫. TT 64/2025 chỉ giảm lệ phí đăng ký (25,000₫).
12. **Thuế:**
   - Lệ phí môn bài bãi bỏ từ 1/1/2026: đúng (NQ 198/2025, NĐ 362/2025).
   - NĐ 141/2026 nâng ngưỡng lên 1 tỷ: đúng.
   - Bổ sung miễn CIT 3 năm cho DNNVV mới thành lập (NQ 198/2025).
   - Thuế suất CIT 15%/17%: chưa kiểm chứng lại.
13. **Nhãn hiệu:** dải 1.0–1.36M₫/nhóm khớp nguồn nhưng vẫn ước tính. Lưu ý giảm 50% và miễn phí qua VNeID hết hạn 31/12/2026.
14. **PDPL:**
   - Hiệu lực 1/1/2026 và hạn nộp 60 ngày: đúng.
   - Bổ sung điều kiện mất miễn trừ: từ 100,000 chủ thể dữ liệu trở lên, cung cấp dịch vụ xử lý dữ liệu, hoặc dữ liệu nhạy cảm.
   - Sửa diễn đạt mức phạt: 5% doanh thu, hoặc 3 tỷ nếu không có doanh thu.
   - NĐ 330/2026: chưa xác nhận.
15. **Tính lại tổng 6 tháng:**
   - A: 57.4 → 56.8M₫ (tiết kiệm), 139.8 → 139.3M₫ (đầy đủ).
   - B: 73.4 → 73.8M₫ (tiết kiệm), 162.7 → 172.2M₫ (đầy đủ).
16. **Chưa kiểm chứng lại, coi là (ước tính):**
   - Giá VND của ADP; mức nạp tối thiểu $5 của Claude.
   - iPhone 11/13/15/16; Mac 8GB cũ; MacinCloud.
   - Chữ ký số, hoá đơn, kế toán, phí trọn gói lập công ty.
   - Icon, Figma, Sentry, marketing, coach; domain .app/.vn.

[vcb]: https://webgia.com/ty-gia/vietcombank/17-10-2026.html
[adp]: https://developer.apple.com/programs/whats-included/
[adp-buy]: https://developer.apple.com/support/purchase-activation/
[waiver]: https://developer.apple.com/help/account/membership/fee-waivers/
[enroll]: https://developer.apple.com/programs/enroll/
[duns]: https://developer.apple.com/help/account/membership/D-U-N-S/
[sbp]: https://developer.apple.com/app-store/small-business-program/
[subs]: https://developer.apple.com/app-store/subscriptions/
[exhibit]: https://developer.apple.com/support/downloads/terms/exhibits/Exhibits-to-Schedule-2-and-3-English.pdf
[taxnews]: https://developer.apple.com/news/?id=yo2104n5
[apple-news]: https://developer.apple.com/news/
[xreq]: https://developer.apple.com/news/upcoming-requirements/
[xsys]: https://developer.apple.com/xcode/system-requirements/
[tf]: https://developer.apple.com/testflight/
[compare]: https://developer.apple.com/support/compare-memberships/
[pay]: https://developer.apple.com/help/app-store-connect/getting-paid/overview-of-receiving-payments
[threshold]: https://developer.apple.com/help/app-store-connect/reference/minimum-payment-threshold
[xcloud]: https://developer.apple.com/xcode-cloud/
[9to5]: https://9to5mac.com/2026/05/21/ios-27-will-drop-support-for-four-iphone-models-says-leaker
[stuff]: https://www.stuff.tv/?p=995855
[macos27]: https://www.macobserver.com/news/macos-27-compatibility-list-here-are-all-the-supported-macs/
[mr-256]: https://www.macrumors.com/2026/05/01/mac-mini-now-starts-at-799
[cps-m4]: https://cellphones.com.vn/mac-mini-m4-2024-16gb-256gb.html
[techone]: https://www.techone.vn/macbook/macmini
[vender]: https://vender.vn/collections/mac-mini-m4-1
[hh-m6]: https://hoanghamobile.com/may-tinh-de-ban/mac-mini-m6
[pv-m6]: https://phongvu.vn/may-tinh-bo-apple-mac-mini-m6-12cpu-12gpu-16gb-256gb-bac-mhqk4sa-a--s260805288
[vnr-m6]: https://vnreview.vn/threads/apple-ra-mat-mac-mini-moi-dung-chip-m6-va-m5-pro-gia-tu-25-trieu-dong.90489/
[macvn]: https://macvn.com.vn/san-pham/mac-mini-2020-m1-used-ram-8gb/
[mac24h-99]: https://mac24h.vn/new-99-mac-mini-m1-16gb-256gb.html
[ms24h]: https://macshop24h.vn/mac-mini-2020-m1-16gb-256gb-used
[2t]: https://2tmobile.com/mac-mini-mgnr3-m1-ram-8gb-ssd-256gb-used-99/
[tekcoffee]: https://thetekcoffee.com/bang-gia-mac-mini-m2-cu/
[ddv-m2]: https://didongviet.vn/apple-macbook-imac/apple-mac-mini-m2-8-core-cpu-10-core-gpu-8gb-256gb.html
[xt-cu]: https://www.xtmobile.vn/bang-gia-iphone-cu-moi-nhat
[ngoisao]: https://ngoisao.vn/cong-nghe/xai-gi/bang-gia-iphone-12-dau-thang-10-2026-moi-nhat-iphone-12-pro-max-re-beo-iphone-12-cu-ngang-may-co-d493513.html
[duchuy]: https://www.duchuymobile.com/iphone-12
[cps-ip12]: https://cellphones.com.vn/hang-cu/iphone/iphone-12.html
[gh-docs]: https://docs.github.com/en/enterprise-server@3.17/billing/reference/actions-runner-pricing
[cicd]: https://cicdpipelinecost.com/github-actions-pricing
[codemagic]: https://codemagic.io/pricing
[greenmini]: https://www.greenmini.nl/compare/macincloud-alternative/
[ms-pricing]: https://pricingsaas.com/companies/macstadium
[aws-blog]: https://aws.amazon.com/blogs/aws/use-amazon-ec2-m1-mac-instances-to-build-test-macos-ios-ipados-tvos-and-watchos-apps/
[aws2]: https://instances.vantage.sh/aws/ec2/mac2-m2.metal
[sb-data]: https://raw.githubusercontent.com/supabase/supabase/master/packages/shared-data/pricing.ts
[sb-pricing-md]: https://supabase.com/pricing.md
[sb-smtp]: https://supabase.com/docs/guides/auth/auth-smtp
[sb-smtp2]: https://dreamlit.ai/blog/posts/how-to-send-emails-supabase
[cl-price]: https://platform.claude.com/docs/en/about-claude/pricing
[cl-vision]: https://platform.claude.com/docs/en/build-with-claude/vision
[cl-sonnet55]: https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
[cl-haiku55]: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5
[cl-credits]: https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-api-usage
[cl-min]: https://docs.aisuru.com/en/generative-ai/advanced/providers-api-keys/claude-console-managing-anthropic-api-keys
[com1]: https://www.openprovider.com/blog/com-price-increase-domain-resellers
[com2]: https://tldes.com/pages/com-price-increase-2026
[verisign]: https://www.fool.com/earnings/call-transcripts/2026/04/23/verisign-vrsn-q1-2026-earnings-transcript/
[cfp]: https://developers.cloudflare.com/pages/platform/limits
[resend1]: https://automationatlas.io/answers/resend-free-tier-explained-2026/
[app]: https://domainoffer.net/tld/app/cloudflare
[vn-dom]: https://thuvienphapluat.vn/ma-so-thue/phap-luat-thue/phi-duy-tri-su-dung-ten-mien-quoc-gia-tu-0352025-theo-thong-tu-10-201937.html
[docker]: https://docs.docker.com/subscription/desktop-license/
[sentry]: https://costbench.com/software/developer-tools/sentry/free-plan/
[figma]: https://www.banani.co/blog/figma-pricing-and-credits
[icon1]: https://iconly.ai/blog/icon-design-cost/
[icon2]: https://iconikai.com/blog/app-icon-designer-ai-vs-hiring-2026
[icon3]: https://dribbble.com/services/188497-App-Icon-Design
[hkd]: https://thuvienphapluat.vn/hoi-dap-phap-luat/le-phi-dang-ky-kinh-doanh-2026-hue-bao-nhieu-tien-138080405.html
[nd141-gov]: https://xaydungchinhsach.chinhphu.vn/toan-van-nghi-dinh-so-141-2026-nd-cp-nang-nguong-doanh-thu-khong-phai-chiu-thue-len-1-ty-dong-119260504154326455.htm
[nq198-cit]: https://thuvienphapluat.vn/ma-so-thue/bai-viet/nghi-quyet-198-chinh-sach-thue-phi-ho-tro-dn-phat-trien-kinh-te-tu-nhan-23599-204545.html
[tt64]: https://thuvienphapluat.vn/chinh-sach-phap-luat-moi/vn/ho-tro-phap-luat/chinh-sach-moi/88605/da-co-thong-tu-64-2025-tt-btc-giam-46-khoan-phi-va-le-phi-tu-ngay-01-7-2025-den-ngay-31-12-2026
[dn-fee]: https://thuvienphapluat.vn/ma-so-thue/phap-luat-thue/phi-dang-ky-giay-phep-kinh-doanh-2025-la-bao-nhieu-227459-198754.html
[qd2473]: https://vpubnd.daklak.gov.vn/CMS/Content/VanBan/2026/8.2026/2473_QĐ_UBND%20PL.pdf
[kta-tl]: https://ketoananpha.vn/thanh-lap-cong-ty.html
[kt1]: https://thue.man.net.vn/bao-gia-dich-vu-ke-toan-thue/
[monbai]: https://thuvienphapluat.vn/hoi-dap-phap-luat/cong-van-645ctcs-cua-cuc-thue-ve-viec-thu-nop-le-phi-mon-bai-tu-112026-chi-tiet-the-nao-138078828.html
[vneco]: https://vneconomy.vn/tu-2026-doanh-nghiep-ho-kinh-doanh-chinh-thuc-khong-phai-khai-va-nop-le-phi-mon-bai.htm
[nd362]: https://thuvienphapluat.vn/ma-so-thue/phap-luat-thue/08-quy-dinh-can-biet-ve-le-phi-mon-bai-moi-nhat-2026-295306-217308.html
[cks1]: https://accgroup.vn/gia-gia-han-chu-ky-vnpt
[cks2]: https://accgroup.vn/dich-vu-chu-ky-so-la-gi
[meinv]: https://www.meinvoice.vn/?p=12736
[misa-cit]: https://amis.misa.vn/246961/ap-dung-thue-suat-15-voi-doanh-nghiep-doanh-thu-duoi-3-ty/
[cv4998]: https://thuvienphapluat.vn/hoi-dap-phap-luat/cong-van-4998-thue-gtgt-doi-voi-dich-vu-phan-mem-nhu-the-nao-138073331.html
[tm-tvpl]: https://thuvienphapluat.vn/phap-luat-doanh-nghiep/bai-viet/le-phi-dang-ky-nhan-hieu-2026-la-bao-nhieu-20957.html
[ipvn]: https://www.ipvietnam.gov.vn/en/thong-bao/-/asset_publisher/bHEp9KzHjHwY/content/thong-bao-ve-viec-trien-khai-thuc-hien-thong-tu-so-64-2025-tt-btc-ngay-30-thang-6-nam-2025-cua-bo-truong-bo-tai-chinh-
[tm2]: https://luatminhkhue.vn/chi-phi-dang-ky-nhan-hieu.aspx
[tm-agent]: https://hethongphapluat.com/phap-luat/node/14937
[pdpl1]: https://luatvietnam.vn/linh-vuc-khac/ho-so-danh-gia-tac-dong-xu-ly-du-lieu-ca-nhan-nop-truoc-01-01-2026-co-phai-nop-lai-theo-luat-moi-883-106424-article.html
[pdpl-yp]: https://yplawfirm.vn/phap-ly/khi-nao-khong-phai-danh-gia-tac-dong-xu-ly-du-lieu-ca-nhan
[pdpl-fine]: https://dataprivacy.vn/2026/01/21/luat-bao-ve-du-lieu-ca-nhan-2025-muc-phat-theo-doanh-thu-va-gio-g-chuyen-doi-cho-doanh-nghiep/
[pdpl-uc]: https://www.uniconsent.com/vietnam-pdpl
[pdpl-bw]: https://bewiseapps.com/doing-business-in-vietnam/intellectual-property-data-and-technology/personal-data-protection
[luatvietan]: https://luatvietan.vn/tu-van-danh-gia-tac-dong-xu-ly-du-lieu-ca-nhan.html
[moit1]: https://lsvn.vn/son-la-trien-khai-thuc-hien-luat-thuong-mai-dien-tu-a177539.html
[moit2]: https://pbgdpl.cantho.gov.vn/trien-khai-nghi-dinh-so-2482026nd-cp-ngay-30-thang-6-nam-2026-cua-chinh-phu-quy-dinh-chi-tiet-mot-so-dieu-cua-luat-thuong-mai-dien-tu
[moit-law]: https://www.vietnam-briefing.com/news/vietnams-e-commerce-law-2025-key-provisions-and-business-implications.html
[wipo]: https://www.wipo.int/en/web/madrid-system/how_to/file/fees
[tiktok]: https://www.brandsvietnam.com/congdong/topic/346263-chi-phi-quang-cao-tiktok-bao-nhieu-cach-toi-uu-ngan-sach
[meta]: https://stackmatix.com/blog/facebook-ads-cpm-by-country-2026
[af]: https://appsflyer.com/benchmarks/finance/mobile-banking/mobile-banking---overall/android/vietnam/2023-05-01/overall
[kol]: https://www.brandsvietnam.com/congdong/topic/339252-REVU-3-yeu-to-anh-huong-den-gia-book-KOL-TikTok
[nhandan]: https://nhandan.vn/giai-pickleball-tinh-doan-quang-nam-tranh-cup-trimico-nam-2025-post863788.html
[coach]: https://24hmoney.vn/news/hong-drama-pickleball-ha-noi-thay-thu-300k-gio-lich-kin-ca-tuan-nhung-xem-danh-khong-khac-gi-newbie-c29a2609033.html
[reclub]: https://reclub.co/m/YXE4DI
