> **BẢN NHÁP – cần luật sư Việt Nam rà soát trước khi phát hành / DRAFT – requires review by Vietnamese counsel**

# Chính sách quyền riêng tư – RacketCoach

Phiên bản: {{CONSENT_VERSION}} · Có hiệu lực từ: {{EFFECTIVE_DATE}}
Bản tiếng Anh: https://{{LEGAL_HOST}}/en/privacy. Nếu hai bản có khác biệt, bản tiếng Việt được ưu tiên áp dụng.

<!--
Ghi chú cho người soạn và luật sư (không hiển thị khi xuất bản):
- Khung pháp lý: Luật Bảo vệ dữ liệu cá nhân số 91/2025/QH15 (hiệu lực 01/01/2026) và Nghị định 356/2025/NĐ-CP. Cần luật sư xác nhận thuật ngữ, số điều khoản, thời hạn trả lời yêu cầu và cơ quan tiếp nhận khiếu nại.
- Cần quyết định: dữ liệu tư thế có bị coi là dữ liệu sinh trắc học (dữ liệu nhạy cảm) không; xem dpia.md mục 9.
- Thời hạn lưu trữ lấy từ DESIGN.md §6.6. Thời hạn của Anthropic lấy từ trang chính sách của Anthropic, kiểm tra lại ngay trước khi phát hành.
- Phải khớp với consent-texts.vi.md, ai-disclosure.vi.md, appstore/privacy-label.md.
-->

## 1. Chúng tôi là ai

RacketCoach là ứng dụng iPhone giúp người chơi cầu lông và pickleball cải thiện kỹ thuật bằng nhận xét do AI tạo. Ứng dụng do **{{COMPANY_NAME}}** ("chúng tôi") phát triển và vận hành, địa chỉ {{COMPANY_ADDRESS}}, mã số {{COMPANY_REG_NO}}.

Với dữ liệu cá nhân mô tả trong chính sách này, chúng tôi là **bên kiểm soát và xử lý dữ liệu cá nhân**. Bạn là **chủ thể dữ liệu**. Liên hệ về quyền riêng tư: **{{CONTACT_EMAIL}}**.

## 2. Tóm tắt nhanh

- **Video của bạn không bao giờ được tải lên.** Ứng dụng phân tích video ngay trên iPhone.
- Để phân tích, chúng tôi gửi đi **dữ liệu tư thế** (toạ độ các khớp cơ thể theo thời gian) và **tối đa 5 ảnh tĩnh** đã cắt quanh người đánh. Trong ảnh, khuôn mặt được tự động làm mờ ở mức tốt nhất có thể (không đảm bảo trong mọi trường hợp) và những người khác bị che.
- Ảnh tĩnh bị **xoá ngay khi phân tích xong**, chậm nhất sau 72 giờ.
- Dữ liệu được lưu tại **Singapore** (Supabase) và được AI **Claude của Anthropic (Hoa Kỳ)** phân tích. Chúng tôi chỉ làm việc này khi bạn đồng ý.
- Không cần tạo tài khoản. Không quảng cáo, không theo dõi, không bán dữ liệu.
- Bạn có thể rút lại đồng ý, xoá từng phân tích hoặc xoá toàn bộ tài khoản ngay trong ứng dụng.
- Ứng dụng dành cho người **từ 18 tuổi trở lên**.

## 3. Dữ liệu chúng tôi xử lý

### 3.1 Dữ liệu được gửi đến máy chủ

| Nhóm dữ liệu | Gồm những gì | Nguồn |
|---|---|---|
| Định danh tài khoản | Mã người dùng ngẫu nhiên (tạo tự động khi mở ứng dụng lần đầu, không cần đăng ký) | Tự động |
| Thông tin đăng nhập (chỉ khi bạn chọn "Lưu lịch sử") | Địa chỉ email, hoặc mã định danh và email (có thể là email ẩn danh của Apple) từ Đăng nhập bằng Apple; mã làm mới của Apple được mã hoá, chỉ dùng để thu hồi khi bạn xoá tài khoản | Bạn cung cấp |
| Hồ sơ | Năm sinh và xác nhận đủ tuổi; tay thuận; trình độ (không bắt buộc); ngôn ngữ | Bạn cung cấp |
| Bản ghi đồng ý | Phiên bản và thời điểm bạn đồng ý hoặc rút lại; các lựa chọn không bắt buộc | Tự động |
| Dữ liệu phân tích | Dữ liệu tư thế (toạ độ 19 khớp cơ thể theo thời gian, đã trích xuất trên iPhone); thông tin kỹ thuật của video (độ phân giải, số khung hình mỗi giây, thời lượng, phiên bản iOS và công cụ nhận diện tư thế); môn, kỹ thuật, góc quay; người trong video là bạn hay người khác, có dưới 16 tuổi không; các cú đánh bạn bỏ chọn | Ứng dụng tạo ra từ video của bạn, cùng lựa chọn của bạn |
| Ảnh tĩnh | Tối đa 5 ảnh JPEG cắt quanh người đánh, cạnh dài 768 px, không kèm siêu dữ liệu (vị trí, thiết bị). Khuôn mặt được làm mờ ở mức tốt nhất có thể; những người khác bị che. **Không có ảnh nào được gửi khi người trong video dưới 16 tuổi** | Ứng dụng tạo ra từ video của bạn |
| Kết quả phân tích | Điểm, nhận xét, kế hoạch tập; đầu ra gốc của AI | Do hệ thống và AI tạo ra |
| Mua hàng | Mã giao dịch, gói, ngày hết hạn, trạng thái gia hạn, dùng thử, hoàn tiền, do Apple cung cấp. Chúng tôi **không** nhận thông tin thẻ hay phương thức thanh toán của bạn | Apple |
| Lượt dùng và sử dụng ứng dụng | Số lượt đã dùng; sự kiện sử dụng trong ứng dụng (ví dụ: mở màn hình, gửi phân tích, xem kết quả), không kèm nội dung video; đánh giá hữu ích/không hữu ích và góp ý (tối đa 500 ký tự) nếu bạn gửi | Tự động / bạn cung cấp |
| Chống lạm dụng | Kết quả kiểm tra DeviceCheck của Apple (chỉ để biết thiết bị đã dùng lượt phân tích nâng cao miễn phí đầu tiên hay chưa; chúng tôi không nhận được mã định danh thiết bị); địa chỉ IP trong nhật ký kỹ thuật và giới hạn tần suất | Tự động |

### 3.2 Dữ liệu chỉ nằm trên iPhone của bạn

- Video gốc và đoạn video đã cắt. Ứng dụng tự xoá video cũ hơn 60 ngày (có thông báo); bạn có thể xoá bất cứ lúc nào trong **Cài đặt › Bộ nhớ**. Thư mục này không được sao lưu lên iCloud.
- Các ảnh khung hình chưa làm mờ dùng để hiển thị kết quả trên máy.
- Bản sao kết quả để xem khi không có mạng.

### 3.3 Dữ liệu chúng tôi không thu thập

Âm thanh (ứng dụng không dùng micro), họ tên, số điện thoại, danh bạ, vị trí, thư viện ảnh (bạn chỉ chọn từng video qua trình chọn của iOS), mã quảng cáo. Ứng dụng không chứa công cụ phân tích hay quảng cáo của bên thứ ba.

## 4. Mục đích và cơ sở xử lý

Cơ sở xử lý chính là **sự đồng ý của bạn**, được xin riêng cho từng mục đích, ngay trước lần phân tích đầu tiên, không bao giờ được chọn sẵn.

| Mục đích | Dữ liệu dùng | Cơ sở |
|---|---|---|
| Phân tích kỹ thuật và trả kết quả | Dữ liệu phân tích, ảnh tĩnh, hồ sơ | Đồng ý (a) xử lý và chuyển dữ liệu ra nước ngoài, và (b) xử lý bằng AI của Anthropic |
| Lưu lịch sử, đồng bộ giữa các thiết bị | Định danh, thông tin đăng nhập, kết quả | Đồng ý (a); bạn chủ động liên kết tài khoản |
| Quản lý gói đăng ký và lượt dùng | Mua hàng, lượt dùng, định danh | Đồng ý (a); thực hiện hợp đồng với bạn |
| Bảo đảm an toàn, chống lạm dụng, xử lý sự cố | Nhật ký kỹ thuật, DeviceCheck, lượt dùng | Đồng ý (a) |
| Hiểu cách ứng dụng được dùng để cải thiện trải nghiệm | Sự kiện sử dụng (bên thứ nhất, không quảng cáo) | Đồng ý (a) |
| Hiệu chỉnh độ chính xác của thang chấm | Dữ liệu tư thế và kết quả đã loại bỏ thông tin định danh, **không gồm ảnh** | Chỉ khi bạn bật mục (c) – không bắt buộc |
| Trả lời Apple khi bạn yêu cầu hoàn tiền | Tóm tắt mức sử dụng và mua hàng | Chỉ khi bạn bật mục (d) – không bắt buộc |
| Tuân thủ pháp luật (kế toán, thuế, yêu cầu của cơ quan có thẩm quyền) | Mua hàng, bản ghi đồng ý | Nghĩa vụ pháp lý |

<!-- Luật sư: xác nhận các trường hợp xử lý không cần đồng ý theo Luật 91/2025 (thực hiện hợp đồng, nghĩa vụ pháp lý) và cách trình bày phù hợp. -->

## 5. Trí tuệ nhân tạo

Nhận xét được tạo bởi **Claude**, mô hình AI của **Anthropic PBC** (Hoa Kỳ). Các con số (góc, điểm) do mã của chúng tôi tính; AI đánh giá những điểm chỉ thấy được qua ảnh và viết lời nhận xét. Nhận xét có thể chưa chính xác và không phải lời khuyên y tế. Chi tiết: **Công bố về AI** tại https://{{LEGAL_HOST}}/vi/ai.

## 6. Ai nhận dữ liệu của bạn

Chúng tôi **không bán** dữ liệu cá nhân và không chia sẻ dữ liệu cho mục đích quảng cáo. Dữ liệu chỉ được chuyển cho các bên xử lý giúp chúng tôi vận hành dịch vụ, theo hợp đồng và chỉ trong phạm vi cần thiết:

| Bên nhận | Vai trò | Dữ liệu | Nơi xử lý |
|---|---|---|---|
| Supabase, Inc. (hạ tầng trên Amazon Web Services) | Lưu trữ cơ sở dữ liệu, tệp, xác thực, chạy máy chủ | Toàn bộ dữ liệu ở mục 3.1 | Singapore (vùng ap-southeast-1) |
| Anthropic PBC | Mô hình AI Claude tạo nhận xét | Dữ liệu tư thế đã tính toán, tối đa 5 ảnh tĩnh, môn, kỹ thuật, tay thuận, trình độ, góc quay. Không gửi email, năm sinh hay mã người dùng | Hoa Kỳ |
| Apple Inc. | Thanh toán qua App Store, Đăng nhập bằng Apple, DeviceCheck; thông tin sử dụng khi bạn yêu cầu hoàn tiền (chỉ khi bạn bật mục (d)) | Mã giao dịch, mã tài khoản ngẫu nhiên, tóm tắt sử dụng | Hoa Kỳ và các nước Apple vận hành |
| {{EMAIL_PROVIDER}} | Gửi mã đăng nhập qua email | Địa chỉ email, nội dung email chứa mã | {{EMAIL_PROVIDER_COUNTRY}} |

Chúng tôi có thể cung cấp dữ liệu cho cơ quan nhà nước có thẩm quyền khi pháp luật yêu cầu.

## 7. Chuyển dữ liệu ra nước ngoài

Dữ liệu của bạn được chuyển ra ngoài Việt Nam: đến **Singapore** (Supabase) và **Hoa Kỳ** (Anthropic, Apple). Chúng tôi chỉ chuyển khi bạn đã đồng ý ở mục (a) và (b), và áp dụng các biện pháp bảo vệ sau:
- chỉ gửi dữ liệu tối thiểu cần cho phân tích; video không bao giờ rời iPhone;
- làm mờ khuôn mặt và che người khác trước khi ảnh rời iPhone; không gửi ảnh của người dưới 16 tuổi;
- mã hoá khi truyền (HTTPS/TLS) và khi lưu trữ;
- thoả thuận xử lý dữ liệu với từng bên nhận;
- xoá ảnh ngay sau phân tích; giới hạn thời gian lưu các dữ liệu khác (mục 8).

Chúng tôi lập và nộp hồ sơ đánh giá tác động chuyển dữ liệu cá nhân ra nước ngoài cho cơ quan có thẩm quyền theo quy định.

## 8. Thời gian lưu trữ

| Dữ liệu | Thời gian lưu |
|---|---|
| Video | Không tải lên. Trên iPhone: tự xoá sau 60 ngày hoặc khi bạn xoá |
| Ảnh tĩnh trên máy chủ | Xoá ngay khi phân tích xong; chậm nhất 72 giờ nếu phân tích lỗi hoặc bị bỏ dở |
| Phân tích đã chuẩn bị nhưng chưa gửi | Xoá sau 24 giờ cùng các tệp liên quan |
| Dữ liệu tư thế | Đến khi bạn xoá phân tích hoặc tài khoản; tự xoá sau 24 tháng bạn không dùng ứng dụng |
| Kết quả phân tích và lịch sử | Đến khi bạn xoá phân tích hoặc tài khoản |
| Đầu ra gốc của AI | 90 ngày |
| Sự kiện sử dụng | 13 tháng |
| Hồ sơ, bản ghi đồng ý, lượt dùng | Đến khi bạn xoá tài khoản |
| Mua hàng | Liên kết với bạn bị gỡ khi bạn xoá tài khoản; bản ghi giao dịch được giữ trong thời hạn pháp luật kế toán, thuế yêu cầu |
| Nhật ký kỹ thuật (có địa chỉ IP) | {{INFRA_LOG_RETENTION}} |
| Dữ liệu tại Anthropic | Theo chính sách hiện hành của Anthropic: tự động xoá trong vòng 30 ngày; tối đa 2 năm nếu nội dung bị hệ thống an toàn gắn cờ vi phạm chính sách sử dụng. Anthropic không dùng dữ liệu này để huấn luyện mô hình |

<!-- Kiểm tra lại thời hạn của Anthropic (privacy.claude.com, bài "How long do you store my organization's data?") và của Supabase ngay trước khi phát hành. Câu hỏi mở: có cần giới hạn thời gian lưu kết quả và tài khoản không hoạt động không (dpia.md mục 13). -->

## 9. Bảo mật

Kết nối được mã hoá (HTTPS/TLS); dữ liệu được mã hoá khi lưu trữ. Mỗi người dùng chỉ truy cập được dữ liệu của chính mình (phân quyền ở cấp hàng và thư mục). Mã đăng nhập của Apple được mã hoá riêng. Nhật ký kỹ thuật không chứa nội dung phân tích. Chỉ số ít người vận hành được truy cập hệ thống, theo nguyên tắc tối thiểu.

Nếu xảy ra sự cố lộ dữ liệu, chúng tôi sẽ thông báo cho cơ quan có thẩm quyền và cho bạn theo thời hạn pháp luật quy định.

## 10. Quyền của bạn

| Quyền | Cách thực hiện |
|---|---|
| Được biết về việc xử lý dữ liệu | Chính sách này; **Cài đặt › Quyền riêng tư › Chúng tôi gửi gì** |
| Đồng ý hoặc không đồng ý | Màn hình đồng ý trước lần phân tích đầu tiên. Không đồng ý (a) và (b) thì không thể phân tích, nhưng vẫn xem được phân tích mẫu |
| Rút lại đồng ý | **Cài đặt › Quyền riêng tư** (xem mục 11) |
| Truy cập và xem dữ liệu | Xem lịch sử, hồ sơ, gói đăng ký ngay trong ứng dụng. Muốn nhận bản sao dữ liệu: gửi email đến {{CONTACT_EMAIL}} |
| Chỉnh sửa | **Cài đặt › Hồ sơ** (tay thuận, trình độ, ngôn ngữ) |
| Xoá dữ liệu | Xoá từng phân tích trong **Lịch sử**; xoá video trên máy trong **Cài đặt › Bộ nhớ**; xoá toàn bộ tài khoản trong **Cài đặt › Xoá tài khoản** |
| Hạn chế xử lý, phản đối xử lý | Tắt các mục (c), (d) bất cứ lúc nào; các yêu cầu khác gửi đến {{CONTACT_EMAIL}} |
| Khiếu nại, tố cáo, khởi kiện; yêu cầu bồi thường | Liên hệ chúng tôi trước qua {{CONTACT_EMAIL}}; bạn cũng có quyền khiếu nại đến cơ quan chuyên trách bảo vệ dữ liệu cá nhân thuộc Bộ Công an |

Chúng tôi trả lời yêu cầu trong thời hạn pháp luật quy định. Để bảo vệ bạn, chúng tôi có thể cần xác minh rằng yêu cầu đến từ chủ tài khoản, ví dụ yêu cầu được gửi từ email đã liên kết với tài khoản.

## 11. Rút lại đồng ý

Vào **Cài đặt › Quyền riêng tư** để:
- **Rút lại đồng ý (a) hoặc (b):** chúng tôi ngừng nhận phân tích mới từ bạn. Dữ liệu đã lưu vẫn còn cho đến khi bạn xoá phân tích hoặc xoá tài khoản; nếu muốn xoá luôn, hãy làm theo mục 10 hoặc mục 12.
- **Tắt (c) hiệu chỉnh độ chính xác** hoặc **(d) chia sẻ với Apple khi hoàn tiền:** có hiệu lực ngay cho các lần xử lý sau.

Việc rút lại không ảnh hưởng đến tính hợp pháp của việc xử lý đã thực hiện trước đó.

<!-- Luật sư: xác nhận việc rút lại đồng ý (a)/(b) có bắt buộc xoá dữ liệu đã lưu hay chỉ ngừng xử lý (pdpl-checklist.md). -->

## 12. Xoá tài khoản

Vào **Cài đặt › Xoá tài khoản** (áp dụng cho cả tài khoản chưa đăng nhập). Khi bạn xác nhận, chúng tôi:
1. thu hồi quyền Đăng nhập bằng Apple của ứng dụng (nếu có);
2. xoá toàn bộ ảnh, dữ liệu tư thế, kết quả, hồ sơ, bản ghi đồng ý, lượt dùng và sự kiện sử dụng của bạn;
3. gỡ liên kết giữa bạn và giao dịch mua;
4. chỉ giữ một bản ghi kiểm toán đã mã hoá một chiều, không dùng để nhận diện bạn.

**Xoá tài khoản không tự huỷ gói đăng ký.** Hãy huỷ trong **Cài đặt iPhone › [tên bạn] › Đăng ký**. Nếu ứng dụng không tự thu hồi được Đăng nhập bằng Apple, bạn có thể tự gỡ trong **Cài đặt iPhone › [tên bạn] › Đăng nhập & Bảo mật › Đăng nhập bằng Apple**.

<!-- Kiểm tra tên mục Cài đặt trên iPhone tiếng Việt (M16). -->

## 13. Độ tuổi

RacketCoach dành cho người **từ 18 tuổi trở lên**. Ứng dụng hỏi năm sinh và không cho người chưa đủ tuổi sử dụng. Nếu biết một tài khoản thuộc về người dưới 18 tuổi, chúng tôi sẽ xoá tài khoản đó.

**Quay trẻ em:** nếu người trong video dưới 16 tuổi, người dùng phải là cha, mẹ hoặc người giám hộ hợp pháp, hoặc đã được người đó đồng ý. Khi đó phân tích chỉ dùng dữ liệu tư thế và **không có ảnh nào được tải lên**.

## 14. Quay người khác

Bạn chỉ được quay và phân tích người khác khi người đó đã đồng ý; ứng dụng yêu cầu bạn xác nhận trước khi phân tích. Ứng dụng tự động che những người không phải người đánh và làm mờ khuôn mặt ở mức tốt nhất có thể. Người được quay có thể liên hệ {{CONTACT_EMAIL}} để yêu cầu xoá dữ liệu liên quan đến họ.

## 15. Không theo dõi, không quảng cáo

Chúng tôi không theo dõi bạn trên các ứng dụng hay trang web khác, không dùng mã quảng cáo, không chia sẻ dữ liệu với bên môi giới dữ liệu hay mạng quảng cáo.

## 16. Thay đổi chính sách

Khi thay đổi chính sách, chúng tôi cập nhật ngày hiệu lực ở đầu trang. Nếu thay đổi ảnh hưởng đến những gì bạn đã đồng ý, ứng dụng sẽ hỏi lại sự đồng ý của bạn trước lần phân tích tiếp theo.

## 17. Liên hệ

{{COMPANY_NAME}}
{{COMPANY_ADDRESS}}
Email: {{CONTACT_EMAIL}}
Trang hỗ trợ: https://{{SUPPORT_HOST}}/vi/
