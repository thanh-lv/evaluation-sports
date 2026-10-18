> **BẢN NHÁP – cần luật sư Việt Nam rà soát trước khi phát hành / DRAFT – requires review by Vietnamese counsel**

# Hồ sơ đánh giá tác động chuyển dữ liệu cá nhân ra nước ngoài (CTIA) – RacketCoach

*Draft template. Headings in English, content in Vietnamese. Base: Personal Data Protection Law No. 91/2025/QH15 and Decree 356/2025/ND-CP. Counsel must map this draft onto the official form issued with Decree 356 before filing with the Ministry of Public Security. Read together with `dpia.md`.*

| Mục | Giá trị |
|---|---|
| Phiên bản hồ sơ | {{CTIA_VERSION}} |
| Ngày lập | {{CTIA_DATE}} |
| Người lập | {{CTIA_AUTHOR}} |
| Trạng thái | Bản nháp, chưa nộp |

## 1. Transferor / Bên chuyển dữ liệu

- {{COMPANY_NAME}}, mã số {{COMPANY_REG_NO}}, địa chỉ {{COMPANY_ADDRESS}}.
- Người đại diện: {{LEGAL_REPRESENTATIVE}}; liên hệ bảo vệ dữ liệu: {{DPO_CONTACT}}, {{CONTACT_EMAIL}}.
- Hoạt động: vận hành ứng dụng iPhone RacketCoach (nhận xét kỹ thuật cầu lông, pickleball bằng AI), phát hành trên App Store Việt Nam.

## 2. Recipients / Bên nhận dữ liệu

| # | Bên nhận | Trụ sở | Nơi xử lý | Vai trò |
|---|---|---|---|---|
| N1 | Supabase, Inc. | Hoa Kỳ | Singapore (AWS ap-southeast-1); một số dịch vụ hỗ trợ có thể ở nơi khác theo DPA | Bên xử lý: cơ sở dữ liệu, kho tệp, xác thực, hàm máy chủ |
| N2 | Anthropic PBC | San Francisco, Hoa Kỳ | Hoa Kỳ | Bên xử lý: mô hình AI Claude tạo nhận xét |
| N3 | Apple Inc. | Cupertino, Hoa Kỳ | Hoa Kỳ và nơi khác | Thanh toán App Store, Đăng nhập bằng Apple, DeviceCheck; nhận tóm tắt sử dụng khi người dùng yêu cầu hoàn tiền (chỉ khi có đồng ý (d)) |
| N4 | {{EMAIL_PROVIDER}} | {{EMAIL_PROVIDER_COUNTRY}} | {{EMAIL_PROVIDER_COUNTRY}} | Bên xử lý: gửi email mã đăng nhập |

## 3. Data transferred / Dữ liệu được chuyển

| Bên nhận | Dữ liệu | Chủ thể | Tần suất | Lượng mỗi lần |
|---|---|---|---|---|
| N1 | Toàn bộ dữ liệu trong `dpia.md` mục 3: định danh, hồ sơ, dữ liệu tư thế, ≤ 5 ảnh đã làm mờ mặt, kết quả, giao dịch, sự kiện sử dụng, nhật ký kỹ thuật | Người dùng; người được quay | Mỗi phân tích và mỗi thao tác | Dữ liệu tư thế ≤ 1,2 MB; mỗi ảnh ≤ 2 MB (thực tế ~100–200 KB) |
| N2 | Bảng số liệu đo được từ dữ liệu tư thế; ≤ 5 ảnh (không có khi người được quay dưới 16 tuổi); môn, kỹ thuật, góc quay, tay thuận, trình độ, ngôn ngữ nhận xét. **Không** có email, năm sinh, mã người dùng | Người dùng; người được quay | Mỗi phân tích | ~6–10 nghìn token |
| N3 | Mã giao dịch, mã tài khoản ngẫu nhiên (appAccountToken); token DeviceCheck; tóm tắt sử dụng khi hoàn tiền (chỉ với đồng ý (d)) | Người dùng | Khi mua, khôi phục, phân tích miễn phí đầu tiên, yêu cầu hoàn tiền | Nhỏ |
| N4 | Địa chỉ email; nội dung email có mã | Người dùng liên kết email | Khi đăng nhập bằng email | Nhỏ |

## 4. Purpose / Mục đích chuyển

- N1: lưu trữ và vận hành dịch vụ (Việt Nam chưa có vùng Supabase; Singapore là vùng gần nhất về độ trễ).
- N2: tạo nhận xét kỹ thuật bằng mô hình AI; không có nhà cung cấp tương đương trong nước đáp ứng chất lượng nhận xét tiếng Việt và khả năng xử lý ảnh theo yêu cầu.
- N3: thanh toán, đăng nhập, chống lạm dụng theo yêu cầu bắt buộc của nền tảng iOS.
- N4: xác thực người dùng qua email.

## 5. Legal basis / Căn cứ chuyển

- Sự đồng ý rõ ràng, riêng biệt của chủ thể: (a) xử lý và chuyển ra nước ngoài (nêu rõ Singapore), (b) xử lý bằng AI của Anthropic (nêu rõ Hoa Kỳ). Văn bản: `consent-texts.vi.md`. Bản ghi đồng ý có phiên bản và thời điểm, lưu tại `profiles`.
- Với người được quay không phải người dùng: người dùng xác nhận đã có sự đồng ý của họ (và của người giám hộ với người dưới 16 tuổi). <!-- Luật sư: đánh giá tính đầy đủ của cơ chế xác nhận này. -->

## 6. Destination assessment / Đánh giá mức độ bảo vệ tại nơi nhận

| Nơi nhận | Khung pháp lý chính | Nhận xét |
|---|---|---|
| Singapore | Luật Bảo vệ dữ liệu cá nhân 2012 (PDPA) | Có luật chuyên ngành, cơ quan giám sát (PDPC), nghĩa vụ bảo vệ và thông báo sự cố |
| Hoa Kỳ | Không có luật liên bang tổng quát; luật tiểu bang (ví dụ California CCPA/CPRA); luật giám sát (FISA 702) | Rủi ro truy cập của cơ quan nhà nước; giảm thiểu bằng tối thiểu hoá dữ liệu, không gửi định danh cho N2, thời hạn lưu ngắn |

<!-- Luật sư: bổ sung đánh giá theo đúng tiêu chí của mẫu Nghị định 356. -->

## 7. Safeguards / Biện pháp bảo vệ

- **Hợp đồng:** DPA với Supabase ({{SUPABASE_DPA_REF}}), điều khoản thương mại và DPA của Anthropic ({{ANTHROPIC_DPA_REF}}), Thoả thuận Chương trình nhà phát triển Apple, DPA với {{EMAIL_PROVIDER}} ({{EMAIL_DPA_REF}}).
- **Tối thiểu hoá:** video không bao giờ rời iPhone; ảnh che người khác, làm mờ mặt (ở mức tốt nhất có thể), cắt sát, 768 px, không siêu dữ liệu; không ảnh cho người dưới 16 tuổi; không gửi định danh cho Anthropic.
- **Thời hạn:** ảnh xoá ngay khi phân tích xong (tối đa 72 giờ); Anthropic xoá trong 30 ngày (tối đa 2 năm nếu bị gắn cờ vi phạm) và không huấn luyện trên dữ liệu API; các thời hạn khác ở `dpia.md` mục 8.
- **Kỹ thuật:** TLS khi truyền; mã hoá khi lưu; phân quyền cấp hàng và thư mục; khoá API chỉ ở máy chủ; không gửi khoá dịch vụ xuống ứng dụng.
- **Tổ chức:** quản trị viên giới hạn, xác thực hai lớp, rà soát định kỳ.
- **Dự phòng lưu trữ tại Việt Nam (CT-1):** nếu luật sư kết luận phải lưu tại Việt Nam, sao chép mã hoá hằng đêm các bảng người dùng sang kho lưu trữ đặt tại Việt Nam.

## 8. Risks and mitigations / Rủi ro và biện pháp giảm thiểu

| Rủi ro | Biện pháp | Rủi ro còn lại |
|---|---|---|
| Cơ quan nước ngoài truy cập dữ liệu | Tối thiểu hoá; không định danh gửi N2; thời hạn ngắn; mã hoá | Thấp |
| Bên nhận dùng dữ liệu sai mục đích | DPA; Anthropic không huấn luyện trên dữ liệu API; kiểm tra chính sách định kỳ | Thấp |
| Lộ dữ liệu tại bên nhận | Bên nhận có chứng nhận bảo mật ({{SECURITY_CERTS}}); nghĩa vụ thông báo sự cố trong DPA | Thấp |
| Ảnh còn sót mặt người | Làm mờ nhiều lớp, kiểm thử trên thiết bị, xoá tối đa 72 giờ | Thấp–Trung bình |
| Bên nhận đổi chính sách lưu trữ | Kiểm tra trước mỗi bản phát hành; cập nhật văn bản đồng ý và hồ sơ | Thấp |

## 9. Recipient commitments / Cam kết của bên nhận

Trích dẫn điều khoản tương ứng trong DPA của từng bên nhận: xử lý theo chỉ dẫn, bảo mật, hỗ trợ đáp ứng quyền chủ thể, thông báo sự cố, xoá hoặc trả lại dữ liệu khi chấm dứt, cho phép kiểm tra hoặc cung cấp báo cáo kiểm toán. {{DPA_CLAUSE_REFERENCES}}

## 10. Annexes / Tài liệu kèm theo

1. Chính sách quyền riêng tư (vi, en).
2. Văn bản đồng ý trong ứng dụng (`consent-texts.vi.md`, `consent-texts.en.md`).
3. Hồ sơ DPIA (`dpia.md`).
4. Bản sao DPA với từng bên nhận.
5. Sơ đồ luồng dữ liệu (DESIGN.md §3).
6. Giấy tờ pháp lý của bên chuyển.

## 11. Sign-off / Phê duyệt

| Vai trò | Họ tên | Ngày | Chữ ký |
|---|---|---|---|
| Người lập | {{CTIA_AUTHOR}} | | |
| Đại diện pháp luật | {{LEGAL_REPRESENTATIVE}} | | |
| Luật sư rà soát | {{COUNSEL_NAME}} | | |
