> **BẢN NHÁP – cần luật sư Việt Nam rà soát trước khi phát hành / DRAFT – requires review by Vietnamese counsel**

# Hồ sơ đánh giá tác động xử lý dữ liệu cá nhân (DPIA) – RacketCoach

*Draft template. Headings in English, content in Vietnamese. Base: Personal Data Protection Law No. 91/2025/QH15 and Decree 356/2025/ND-CP. Counsel must map this draft onto the official form issued with Decree 356 before filing; section numbers here are not the form's numbers.*

| Mục | Giá trị |
|---|---|
| Phiên bản hồ sơ | {{DPIA_VERSION}} |
| Ngày lập | {{DPIA_DATE}} |
| Người lập | {{DPIA_AUTHOR}} |
| Hạn nộp | Trong thời hạn luật định kể từ ngày bắt đầu xử lý (luật sư xác nhận; tài liệu nghiên cứu ghi 60 ngày) |
| Trạng thái | Bản nháp, chưa nộp |

## 1. Controller information / Thông tin bên kiểm soát và xử lý

- Tên: {{COMPANY_NAME}}; mã số doanh nghiệp/mã số thuế: {{COMPANY_REG_NO}}; địa chỉ: {{COMPANY_ADDRESS}}.
- Người đại diện: {{LEGAL_REPRESENTATIVE}}.
- Bộ phận hoặc người phụ trách bảo vệ dữ liệu cá nhân: {{DPO_CONTACT}}; email {{CONTACT_EMAIL}}.
- Vai trò: bên kiểm soát và xử lý dữ liệu cá nhân. Bên xử lý được thuê: Supabase, Inc.; Anthropic PBC; {{EMAIL_PROVIDER}}. Apple Inc. vừa là bên cung cấp dịch vụ thanh toán, đăng nhập, vừa là bên kiểm soát độc lập với dữ liệu của chính Apple.
- Loại hình (để xét miễn trừ): {{ENTITY_TYPE}} (cá nhân / hộ kinh doanh / doanh nghiệp nhỏ / doanh nghiệp khởi nghiệp). Xem mục 13, câu hỏi Q1.

## 2. Description of processing / Mô tả hoạt động xử lý

RacketCoach là ứng dụng iPhone nhận xét kỹ thuật cầu lông và pickleball. Luồng xử lý:

1. Người dùng quay hoặc chọn một video (3–30 giây). **Video không rời iPhone.**
2. Trên iPhone, Apple Vision trích xuất 19 khớp cơ thể của người đánh theo thời gian (dữ liệu tư thế).
3. iPhone gửi dữ liệu tư thế đến máy chủ (Supabase, Singapore). Máy chủ làm sạch, tách cú đánh, đo đạc, chấm điểm và chọn 5 thời điểm cần ảnh.
4. iPhone tạo tối đa 5 ảnh tĩnh: che toàn bộ người không phải người đánh, làm mờ đầu và mặt người đánh (cố gắng tối đa, nếu không tìm thấy đầu thì làm mờ phần trên khung người), cắt, thu nhỏ còn 768 px, bỏ siêu dữ liệu, rồi tải lên kho tệp riêng của người dùng. Nếu người được quay dưới 16 tuổi: **không tạo, không tải ảnh**.
5. Máy chủ gửi số liệu đo được và ảnh cho Claude (Anthropic, Hoa Kỳ), nhận lại đánh giá và lời nhận xét có cấu trúc, kiểm tra lại, ghép điểm số và lưu kết quả.
6. Máy chủ **xoá ảnh ngay khi xong**; tác vụ dọn dẹp hằng ngày xoá ảnh còn sót sau 72 giờ.
7. Người dùng xem kết quả, lịch sử; có thể xoá từng phân tích hoặc toàn bộ tài khoản.

Tài khoản ẩn danh được tạo khi mở ứng dụng lần đầu; liên kết Đăng nhập bằng Apple hoặc email là tuỳ chọn. Gói đăng ký mua qua App Store; máy chủ xác minh giao dịch với Apple.

Quy mô dự kiến: {{EXPECTED_SUBJECTS}} chủ thể trong năm đầu (giai đoạn 1 chỉ phát hành tại Việt Nam).

## 3. Data categories and data subjects / Loại dữ liệu và chủ thể

**Chủ thể dữ liệu:**
- Người dùng (từ 18 tuổi, có kiểm tra năm sinh).
- Người được quay không phải người dùng ("người khác"): người dùng phải xác nhận đã có sự đồng ý của họ; có thể là trẻ dưới 16 tuổi (khi đó cần xác nhận của cha, mẹ hoặc người giám hộ và chỉ xử lý dữ liệu tư thế).
- Người lọt vào khung hình ngoài ý muốn: bị che toàn thân trên iPhone trước khi ảnh rời máy.

| Nhóm | Dữ liệu | Phân loại đề xuất | Ghi chú |
|---|---|---|---|
| Định danh | Mã người dùng ngẫu nhiên; email (nếu liên kết); mã Apple và email ẩn danh (nếu dùng Đăng nhập bằng Apple); mã làm mới Apple (mã hoá) | Cơ bản | Không thu thập họ tên, số điện thoại |
| Hồ sơ | Năm sinh, xác nhận tuổi, tay thuận, trình độ, ngôn ngữ | Cơ bản | |
| Hình ảnh | Tối đa 5 ảnh tĩnh đã làm mờ mặt, cắt quanh người đánh | Cơ bản (hình ảnh cá nhân) | Lưu tối đa 72 giờ. Làm mờ có thể sót |
| Dữ liệu tư thế | Toạ độ 2D của 19 khớp theo thời gian; số đo góc, tốc độ | **Cần luật sư kết luận** | Không dùng để nhận dạng người; xem Q2 |
| Kết quả | Điểm, nhận xét, kế hoạch tập | Cơ bản | |
| Giao dịch | Mã giao dịch, gói, trạng thái từ Apple | Cơ bản | Không có dữ liệu thẻ |
| Sử dụng | Sự kiện trong ứng dụng, lượt dùng, đánh giá, góp ý | Cơ bản | Bên thứ nhất, không quảng cáo |
| Kỹ thuật | Địa chỉ IP trong nhật ký, kết quả DeviceCheck | Cơ bản | |
| Trẻ em | Dữ liệu tư thế của người dưới 16 tuổi được quay | **Nhạy cảm (dữ liệu trẻ em) – cần luật sư kết luận** | Không có ảnh; cần xác nhận của người giám hộ |

## 4. Purposes and legal basis / Mục đích và cơ sở pháp lý

| Mục đích | Cơ sở |
|---|---|
| Phân tích kỹ thuật, lưu lịch sử | Đồng ý (a) xử lý và chuyển ra nước ngoài; (b) xử lý bằng AI của Anthropic |
| Quản lý gói đăng ký và lượt | Đồng ý (a); thực hiện hợp đồng |
| An toàn, chống lạm dụng | Đồng ý (a) |
| Thống kê sử dụng bên thứ nhất | Đồng ý (a) |
| Hiệu chỉnh độ chính xác | Đồng ý riêng (c), không bắt buộc, mặc định tắt |
| Gửi thông tin sử dụng cho Apple khi hoàn tiền | Đồng ý riêng (d), không bắt buộc, mặc định tắt |
| Nghĩa vụ kế toán, thuế | Nghĩa vụ pháp lý |

Sự đồng ý được xin ngay trước lần phân tích đầu tiên, có phiên bản, lưu thời điểm; không chọn sẵn; rút lại được trong ứng dụng. Văn bản: `consent-texts.vi.md`.

## 5. Necessity and proportionality / Tính cần thiết và tương xứng

- **Không tải video**; chỉ gửi dữ liệu tư thế và tối đa 5 ảnh đã cắt (thiết kế ban đầu là 9 ảnh, đã giảm còn 5).
- Ảnh: che người khác, làm mờ mặt, cắt sát người đánh, 768 px, không siêu dữ liệu; xoá ngay khi phân tích xong.
- Không thu thập họ tên, âm thanh, vị trí, danh bạ; không SDK quảng cáo hay phân tích của bên thứ ba.
- Không bắt buộc đăng ký tài khoản.
- Người dưới 16 tuổi được quay: chỉ dữ liệu tư thế.
- Người dùng tối thiểu 18 tuổi.
- Dữ liệu gửi Anthropic không gồm định danh người dùng.

## 6. Processors and recipients / Bên xử lý và bên nhận

| Bên | Vai trò | Dữ liệu | Nơi | Thoả thuận |
|---|---|---|---|---|
| Supabase, Inc. (trên AWS) | Cơ sở dữ liệu, kho tệp, xác thực, máy chủ hàm | Toàn bộ | Singapore (ap-southeast-1) | DPA của Supabase: {{SUPABASE_DPA_REF}} |
| Anthropic PBC | Mô hình AI | Số liệu tư thế, ≤ 5 ảnh, môn, kỹ thuật, góc, tay thuận, trình độ | Hoa Kỳ | Điều khoản thương mại và DPA của Anthropic: {{ANTHROPIC_DPA_REF}} |
| Apple Inc. | Thanh toán, Đăng nhập bằng Apple, DeviceCheck, thông tin sử dụng khi hoàn tiền (chỉ khi có đồng ý (d)) | Mã giao dịch, mã tài khoản ngẫu nhiên, tóm tắt sử dụng | Hoa Kỳ và nơi khác | Thoả thuận Chương trình nhà phát triển Apple |
| {{EMAIL_PROVIDER}} | Gửi mã đăng nhập | Email | {{EMAIL_PROVIDER_COUNTRY}} | {{EMAIL_DPA_REF}} |

## 7. Cross-border transfer / Chuyển dữ liệu ra nước ngoài

Có chuyển ra nước ngoài (Singapore, Hoa Kỳ). Chi tiết và đánh giá: hồ sơ `ctia.md`.

## 8. Retention / Thời hạn lưu trữ

| Dữ liệu | Thời hạn | Cơ chế |
|---|---|---|
| Ảnh tĩnh | Xoá khi phân tích xong; tối đa 72 giờ | Hàm hoàn tất phân tích; tác vụ hằng ngày |
| Phân tích chưa gửi | 24 giờ | Tác vụ hằng ngày |
| Thư mục mồ côi | Xoá khi phát hiện | Tác vụ hằng ngày, duyệt đệ quy |
| Dữ liệu tư thế | Đến khi xoá phân tích hoặc tài khoản; 24 tháng không hoạt động | Tác vụ hằng ngày |
| Kết quả, lịch sử | Đến khi xoá phân tích hoặc tài khoản | Người dùng xoá |
| Đầu ra gốc của AI | 90 ngày | Tác vụ hằng ngày |
| Sự kiện sử dụng | 13 tháng | Tác vụ hằng ngày |
| Hồ sơ, đồng ý, lượt | Đến khi xoá tài khoản | Xoá tài khoản |
| Giao dịch | Gỡ liên kết khi xoá tài khoản; giữ bản ghi theo luật kế toán, thuế | Xoá tài khoản |
| Nhật ký kiểm toán xoá tài khoản | {{AUDIT_RETENTION}}; chỉ lưu mã băm một chiều | — |
| Tại Anthropic | 30 ngày; tối đa 2 năm nếu bị gắn cờ vi phạm | Chính sách Anthropic |
| Video trên iPhone | 60 ngày, không sao lưu iCloud | Ứng dụng tự dọn |

## 9. Risk assessment / Đánh giá rủi ro

Thang: Khả năng (Thấp/Trung bình/Cao) × Mức độ ảnh hưởng (Thấp/Trung bình/Cao).

| # | Rủi ro | Khả năng | Ảnh hưởng | Biện pháp | Rủi ro còn lại |
|---|---|---|---|---|---|
| R1 | Làm mờ mặt bị sót, ảnh có mặt người đánh được gửi ra nước ngoài | Trung bình | Trung bình | Kết hợp hộp đầu từ tư thế và nhận diện khuôn mặt; không tìm thấy đầu thì làm mờ phần trên khung người; kiểm thử trên thiết bị; ảnh xoá tối đa 72 giờ; nói rõ "ở mức tốt nhất có thể" trong mọi văn bản | Thấp–Trung bình |
| R2 | Người lọt vào khung hình (kể cả trẻ em) xuất hiện trong ảnh | Trung bình | Trung bình | Che toàn thân mọi người không phải người đánh; ảnh F5 chỉ cắt gấp 2 khung người đánh, không có ảnh toàn cảnh | Thấp |
| R3 | Quay người khác khi chưa được đồng ý | Trung bình | Trung bình | Xác nhận bắt buộc; ràng buộc ở cơ sở dữ liệu; điều khoản sử dụng; kênh yêu cầu xoá cho người được quay | Trung bình |
| R4 | Xử lý dữ liệu trẻ em | Thấp | Cao | Người dùng ≥ 18 tuổi; người được quay dưới 16 tuổi: xác nhận của người giám hộ, chỉ dữ liệu tư thế, không ảnh | Thấp |
| R5 | Dữ liệu tư thế bị coi là sinh trắc học | Không rõ | Cao (nghĩa vụ dữ liệu nhạy cảm, mất miễn trừ) | Không dùng để nhận dạng; không lưu ảnh; chờ luật sư kết luận (Q2) | Chờ kết luận |
| R6 | Truy cập trái phép cơ sở dữ liệu hoặc kho tệp | Thấp | Cao | Phân quyền cấp hàng và thư mục; kiểm thử ma trận quyền; khoá dịch vụ chỉ ở máy chủ; mã hoá khi truyền và lưu | Thấp |
| R7 | Nhà cung cấp AI giữ hoặc dùng dữ liệu ngoài mục đích | Thấp | Trung bình | Không gửi định danh; Anthropic không huấn luyện trên dữ liệu API; thời hạn 30 ngày; nêu rõ trong văn bản đồng ý | Thấp |
| R8 | Nhận xét AI sai hoặc mang tính y khoa gây hại | Trung bình | Trung bình | Mã tính mọi con số; AI chỉ chọn từ dấu hiệu đã đo; bộ lọc thuật ngữ y khoa; ghi chú an toàn cố định; nhãn AI trên mọi kết quả | Thấp |
| R9 | Không đáp ứng kịp yêu cầu của chủ thể | Thấp | Trung bình | Xoá, rút lại, xem dữ liệu ngay trong ứng dụng; quy trình email cho yêu cầu khác | Thấp |
| R10 | Liên kết sai gói đăng ký giữa các tài khoản | Thấp | Thấp | Mã tài khoản lấy từ giao dịch Apple; giới hạn chuyển 3 lần/30 ngày; nhật ký kiểm toán | Thấp |
| R11 | Nhật ký chứa dữ liệu cá nhân | Thấp | Thấp | Nhật ký JSON không có dữ liệu cá nhân; mã băm cho kiểm toán | Thấp |

## 10. Safeguards / Biện pháp bảo vệ

**Kỹ thuật:** HTTPS/TLS; mã hoá khi lưu trữ (Supabase); phân quyền theo hàng (RLS) trên mọi bảng; kho tệp phân quyền theo thư mục người dùng; mã làm mới Apple mã hoá AES-GCM; khoá bí mật trong kho bí mật của máy chủ; giới hạn tần suất; không gửi định danh cho Anthropic; tác vụ xoá tự động hằng ngày; xoá tài khoản đệ quy cả hai kho tệp.

**Tổ chức:** chỉ {{ADMIN_COUNT}} người có quyền quản trị; xác thực hai lớp cho mọi bảng điều khiển (Supabase, Anthropic, App Store Connect, Apple Developer); quy trình xử lý sự cố (mục 12); rà soát hồ sơ này mỗi năm hoặc khi thay đổi đáng kể.

## 11. Data-subject rights / Bảo đảm quyền của chủ thể

| Quyền | Cách đáp ứng |
|---|---|
| Được biết | Chính sách quyền riêng tư; màn hình "Chúng tôi gửi gì" |
| Đồng ý, rút lại | Màn hình đồng ý; Cài đặt › Quyền riêng tư |
| Truy cập | Lịch sử, hồ sơ trong ứng dụng; bản sao qua email |
| Chỉnh sửa | Cài đặt › Hồ sơ |
| Xoá | Xoá phân tích; xoá tài khoản (cả tài khoản ẩn danh) |
| Hạn chế, phản đối | Tắt (c), (d); yêu cầu qua email |
| Người được quay | Yêu cầu xoá qua {{CONTACT_EMAIL}} |

Thời hạn trả lời: {{DSR_RESPONSE_DAYS}} (luật sư xác nhận theo Nghị định 356).

## 12. Breach response / Ứng phó sự cố

1. Phát hiện và khoanh vùng (thu hồi khoá, tạm dừng hàm bị ảnh hưởng).
2. Đánh giá phạm vi: loại dữ liệu, số chủ thể, khả năng gây hại.
3. Thông báo cho cơ quan chuyên trách bảo vệ dữ liệu cá nhân thuộc Bộ Công an trong thời hạn luật định (luật sư xác nhận; quy định trước đây là 72 giờ).
4. Thông báo cho người dùng bị ảnh hưởng khi pháp luật yêu cầu hoặc khi có nguy cơ gây hại.
5. Ghi nhận, khắc phục, cập nhật hồ sơ này.

## 13. Conclusion, open questions and sign-off / Kết luận, câu hỏi mở, phê duyệt

**Kết luận sơ bộ:** với các biện pháp ở mục 5 và 10, rủi ro còn lại ở mức chấp nhận được, trừ R5 đang chờ kết luận pháp lý.

**Câu hỏi cho luật sư:**
- Q1. Loại hình pháp nhân và việc áp dụng miễn trừ hoặc thời gian ân hạn cho doanh nghiệp nhỏ, khởi nghiệp, cá nhân (DPIA, người phụ trách bảo vệ dữ liệu). Miễn trừ có áp dụng cho hồ sơ chuyển dữ liệu ra nước ngoài không?
- Q2. Dữ liệu tư thế 2D (không dùng để nhận dạng) có là dữ liệu sinh trắc học/nhạy cảm không?
- Q3. Dữ liệu tư thế của người dưới 16 tuổi do cha, mẹ quay: yêu cầu về đồng ý và xác minh người giám hộ.
- Q4. Rút lại đồng ý (a)/(b) có buộc xoá dữ liệu đã lưu không, hay chỉ ngừng xử lý mới?
- Q5. Có cần giới hạn thời gian lưu kết quả và tài khoản không hoạt động (hiện chỉ dữ liệu tư thế có giới hạn 24 tháng)?
- Q6. Yêu cầu lưu trữ dữ liệu tại Việt Nam (Luật An ninh mạng 116/2025) với loại hình pháp nhân đã chọn; phương án dự phòng CT-1 (bản sao mã hoá hằng đêm tại Việt Nam).
- Q7. Thời hạn nộp hồ sơ, thời hạn trả lời yêu cầu, thời hạn báo cáo sự cố theo Nghị định 356.

| Vai trò | Họ tên | Ngày | Chữ ký |
|---|---|---|---|
| Người lập | {{DPIA_AUTHOR}} | | |
| Người phụ trách bảo vệ dữ liệu | {{DPO_CONTACT}} | | |
| Đại diện pháp luật | {{LEGAL_REPRESENTATIVE}} | | |
| Luật sư rà soát | {{COUNSEL_NAME}} | | |
