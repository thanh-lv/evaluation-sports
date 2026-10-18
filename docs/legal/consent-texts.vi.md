> **BẢN NHÁP – cần luật sư Việt Nam rà soát trước khi phát hành / DRAFT – requires review by Vietnamese counsel**

# Văn bản xin đồng ý và thông báo trong ứng dụng (tiếng Việt)

Đây là **chữ chính xác** dùng trong ứng dụng. Khi sửa nội dung, sửa ở đây trước rồi chép sang `Localizable.xcstrings` / `InfoPlist.xcstrings`; bản tiếng Anh tương ứng ở `consent-texts.en.md`. Cột "Khoá" là khoá gợi ý cho String Catalog.

**Quy tắc** (DESIGN.md §2.2 bước 5, §11):
- Màn hình đồng ý hiện ngay trước lần gửi phân tích đầu tiên, chặn cho đến khi người dùng chọn; hiện lại mỗi khi phiên bản đồng ý thay đổi.
- Không ô nào được chọn sẵn. Nút "Đồng ý và tiếp tục" chỉ bật khi đã chọn **(a)** và **(b)**.
- Mục (a) lưu vào `profiles.pdpl_consent_version`, mục (b) vào `profiles.ai_consent_version`; giá trị là phiên bản hiện hành trong `app_config.consent_versions` (hiện tại `{"pdpl": "2026-10-01", "ai": "2026-10-01"}`). Mục (c) lưu `calibration_opt_in`, mục (d) lưu `consumption_consent`.
- Sửa nội dung (a) thì tăng `consent_versions.pdpl`; sửa (b) thì tăng `consent_versions.ai`. Máy chủ trả 403 `consent_required` khi phiên bản đã lưu không còn hiện hành.
- Thời hạn của Anthropic trong mục (b) phải khớp chính sách quyền riêng tư; kiểm tra lại ngay trước khi phát hành.

## 1. Màn hình đồng ý trước lần phân tích đầu tiên

| Khoá | Chữ hiển thị |
|---|---|
| `consent.title` | Trước khi phân tích lần đầu |
| `consent.intro` | Để AI nhận xét cú đánh của bạn, chúng tôi cần sự đồng ý của bạn. Hai mục đầu là bắt buộc; hai mục sau tuỳ bạn chọn. |
| `consent.reconsent.title` | Chúng tôi đã cập nhật cách xử lý dữ liệu |
| `consent.reconsent.intro` | Vui lòng xem lại và đồng ý để tiếp tục phân tích. |

### (a) Bắt buộc: xử lý dữ liệu và chuyển dữ liệu ra nước ngoài

| Khoá | Chữ hiển thị |
|---|---|
| `consent.pdpl.title` | Xử lý dữ liệu và lưu trữ tại Singapore (bắt buộc) |
| `consent.pdpl.body` | Chúng tôi xử lý dữ liệu tư thế (vị trí các khớp cơ thể theo thời gian), tối đa 5 ảnh tĩnh và thông tin bạn chọn (môn, kỹ thuật, góc quay, tay thuận, trình độ) để phân tích cú đánh và lưu lịch sử cho bạn. Dữ liệu được lưu trên máy chủ của Supabase tại Singapore, tức là được chuyển ra ngoài Việt Nam. Ảnh tĩnh bị xoá ngay khi phân tích xong, chậm nhất sau 72 giờ. Dữ liệu tư thế và kết quả được giữ đến khi bạn xoá phân tích hoặc tài khoản; dữ liệu tư thế tự xoá sau 24 tháng bạn không dùng ứng dụng. |
| `consent.pdpl.checkbox` | Tôi đồng ý với việc xử lý dữ liệu và chuyển dữ liệu đến Singapore như trên. |

### (b) Bắt buộc: phân tích bằng AI của Anthropic (Claude, Hoa Kỳ)

| Khoá | Chữ hiển thị |
|---|---|
| `consent.ai.title` | Phân tích bằng AI của Anthropic (Claude, Hoa Kỳ) (bắt buộc) |
| `consent.ai.body` | Nhận xét được viết bởi Claude, mô hình AI của Anthropic PBC tại Hoa Kỳ. Với mỗi phân tích, chúng tôi gửi cho Anthropic:<br>• toạ độ tư thế của các cú đánh;<br>• tối đa 5 ảnh tĩnh, trong đó khuôn mặt được tự động làm mờ (ở mức tốt nhất có thể, không đảm bảo trong mọi trường hợp) và những người khác bị che;<br>• môn, kỹ thuật, góc quay, tay thuận và trình độ.<br>Video của bạn không bao giờ được tải lên. Chúng tôi xoá ảnh tĩnh ngay khi phân tích xong, chậm nhất sau 72 giờ. Theo chính sách hiện hành của Anthropic, dữ liệu gửi qua API được tự động xoá trong vòng 30 ngày (lâu hơn nếu bị gắn cờ vi phạm chính sách sử dụng) và không được dùng để huấn luyện AI.<br>Bạn có thể rút lại đồng ý bất cứ lúc nào trong Cài đặt › Quyền riêng tư; khi đó bạn sẽ không tạo được phân tích mới. |
| `consent.ai.checkbox` | Tôi đồng ý gửi dữ liệu nêu trên cho Anthropic tại Hoa Kỳ để AI phân tích. |

`<br>` là xuống dòng; mỗi dòng "•" là một mục danh sách.

### (c) Không bắt buộc, mặc định tắt: cải thiện độ chính xác

| Khoá | Chữ hiển thị |
|---|---|
| `consent.calibration.title` | Cải thiện độ chính xác (không bắt buộc) |
| `consent.calibration.toggle` | Cho phép dùng dữ liệu đã ẩn danh để cải thiện độ chính xác |
| `consent.calibration.body` | Nếu bạn bật, chúng tôi có thể dùng dữ liệu tư thế và kết quả phân tích của bạn, sau khi đã loại bỏ thông tin định danh và không kèm ảnh, để hiệu chỉnh thang chấm và kiểm tra chất lượng. Bạn có thể tắt bất cứ lúc nào trong Cài đặt › Quyền riêng tư. |

### (d) Không bắt buộc, mặc định tắt: chia sẻ thông tin sử dụng với Apple khi hoàn tiền

| Khoá | Chữ hiển thị |
|---|---|
| `consent.consumption.title` | Chia sẻ với Apple khi hoàn tiền (không bắt buộc) |
| `consent.consumption.toggle` | Cho phép gửi thông tin sử dụng cho Apple khi tôi yêu cầu hoàn tiền |
| `consent.consumption.body` | Khi bạn yêu cầu Apple hoàn tiền gói Premium, Apple có thể hỏi chúng tôi về mức sử dụng của bạn. Nếu bạn bật, chúng tôi gửi cho Apple bản tóm tắt như mức độ bạn đã dùng dịch vụ, thời gian sử dụng và lịch sử mua trong ứng dụng; không gửi ảnh, dữ liệu tư thế hay nội dung nhận xét. Nếu bạn không bật, chúng tôi không gửi gì. |

### Nút và liên kết

| Khoá | Chữ hiển thị |
|---|---|
| `consent.button.accept` | Đồng ý và tiếp tục |
| `consent.button.later` | Để sau |
| `consent.required_hint` | Hãy đánh dấu hai mục bắt buộc để tiếp tục. |
| `consent.declined.message` | Bạn vẫn có thể xem phân tích mẫu. Để phân tích video của bạn, cần đồng ý hai mục bắt buộc. |
| `consent.link.privacy` | Chính sách quyền riêng tư |
| `consent.link.ai` | Công bố về AI |

## 2. Quay người khác (bước "Người trong video")

| Khoá | Chữ hiển thị |
|---|---|
| `subject.title` | Người trong video là ai? |
| `subject.self` | Tôi |
| `subject.other` | Người khác |
| `subject.other.consent` | Người trong video đã đồng ý cho tôi quay và phân tích |
| `subject.minor.question` | Người trong video dưới 16 tuổi? |
| `subject.minor.yes` | Có |
| `subject.minor.no` | Không |
| `subject.minor.guardian` | Tôi là cha, mẹ hoặc người giám hộ hợp pháp của người này, hoặc đã được cha, mẹ hoặc người giám hộ đồng ý. |
| `subject.minor.pose_only_note` | Với người dưới 16 tuổi, ứng dụng chỉ gửi dữ liệu tư thế, không gửi ảnh nào. Một số điểm cần nhìn qua ảnh sẽ không được đánh giá. |

Nút tiếp tục chỉ bật khi đã đánh dấu `subject.other.consent` (và `subject.minor.guardian` nếu chọn "Có").

## 3. Độ tuổi (màn hình "Về bạn")

| Khoá | Chữ hiển thị |
|---|---|
| `about.birth_year.title` | Bạn sinh năm nào? |
| `about.age.blocked` | Rất tiếc, RacketCoach hiện chỉ dành cho người từ %lld tuổi trở lên. |
| `about.age.attest` | Tôi xác nhận tôi đã đủ %lld tuổi. |

`%lld` lấy từ `app_config.min_user_age` (hiện là 18). Ô xác nhận chỉ hiện khi năm sinh nằm đúng ở ngưỡng (người dùng có thể chưa đến sinh nhật).

## 4. Quyền dùng camera (`NSCameraUsageDescription`, InfoPlist.xcstrings)

> Ứng dụng dùng camera để quay cú đánh của bạn. Video được phân tích trên máy và không bị tải lên. Chỉ dữ liệu tư thế và tối đa 5 ảnh tĩnh (đã tự động làm mờ khuôn mặt) được gửi đi để AI phân tích, sau khi bạn đồng ý.

Chữ này lấy nguyên văn từ DESIGN.md §10.1; không sửa nếu chưa cập nhật thiết kế.

## 5. Nhãn AI và ghi chú an toàn trên kết quả

| Khoá | Chữ hiển thị |
|---|---|
| `results.footer.ai_label` | Nhận xét do AI tạo, có thể chưa chính xác · Không phải lời khuyên y tế. Dừng tập nếu đau. |
| `results.language_note` | Nhận xét được viết bằng tiếng Anh |
| `results.partial` | Chưa đủ dữ liệu — không tính lượt |
| `results.score.beta` | beta |
| `settings.legal.not_medical` | Không phải lời khuyên y tế |

Dòng `results.footer.ai_label` phải hiện trên **mọi** kết quả, kể cả phân tích mẫu (Luật Trí tuệ nhân tạo 134/2025).

## 6. Cài đặt › Quyền riêng tư

| Khoá | Chữ hiển thị |
|---|---|
| `settings.privacy.title` | Quyền riêng tư |
| `settings.privacy.pdpl.row` | Xử lý và lưu trữ dữ liệu tại Singapore |
| `settings.privacy.ai.row` | Phân tích bằng AI của Anthropic |
| `settings.privacy.accepted_on` | Đã đồng ý ngày %@ |
| `settings.privacy.not_accepted` | Chưa đồng ý |
| `settings.privacy.what_we_send` | Chúng tôi gửi gì |
| `settings.privacy.withdraw` | Rút lại đồng ý |
| `settings.privacy.withdraw.title` | Rút lại đồng ý? |
| `settings.privacy.withdraw.body` | Bạn sẽ không tạo được phân tích mới cho đến khi đồng ý lại. Lịch sử và dữ liệu đã lưu vẫn còn cho đến khi bạn xoá phân tích hoặc xoá tài khoản. |
| `settings.privacy.withdraw.confirm` | Rút lại |
| `common.cancel` | Huỷ |

**Nội dung màn hình "Chúng tôi gửi gì"** (`settings.privacy.what_we_send.body`):

> **Không bao giờ gửi:** video, âm thanh, vị trí, danh bạ.
> **Gửi đến máy chủ của chúng tôi tại Singapore:** dữ liệu tư thế, tối đa 5 ảnh tĩnh (khuôn mặt được làm mờ ở mức tốt nhất có thể, người khác bị che), môn, kỹ thuật, góc quay, tay thuận, trình độ, năm sinh; email nếu bạn liên kết tài khoản.
> **Gửi cho Anthropic (Hoa Kỳ) để AI nhận xét:** số liệu tư thế đã đo, tối đa 5 ảnh tĩnh, môn, kỹ thuật, góc quay, tay thuận, trình độ. Không gửi email, năm sinh hay mã người dùng.
> **Người dưới 16 tuổi:** không gửi ảnh nào, chỉ gửi dữ liệu tư thế.
> **Ảnh tĩnh** bị xoá ngay khi phân tích xong, chậm nhất sau 72 giờ.

## 7. Xoá tài khoản

| Khoá | Chữ hiển thị |
|---|---|
| `settings.delete.row` | Xoá tài khoản |
| `settings.delete.title` | Xoá tài khoản? |
| `settings.delete.body` | Toàn bộ lịch sử phân tích, dữ liệu tư thế, hồ sơ và các lựa chọn đồng ý của bạn sẽ bị xoá vĩnh viễn và không thể khôi phục. |
| `settings.delete.subscription_notice` | Gói Premium vẫn tự động gia hạn cho đến khi bạn huỷ trong Cài đặt iPhone › [tên bạn] › Đăng ký. Xoá tài khoản không tự huỷ gói. |
| `settings.delete.manage_subscription` | Quản lý gói đăng ký |
| `settings.delete.confirm` | Xoá vĩnh viễn |
| `settings.delete.done` | Đã xoá tài khoản. |
| `settings.delete.siwa_manual` | Để ngắt hoàn toàn Đăng nhập bằng Apple, vào Cài đặt iPhone › [tên bạn] › Đăng nhập & Bảo mật › Đăng nhập bằng Apple, chọn RacketCoach rồi chọn ngừng sử dụng. |

`settings.delete.subscription_notice` hiện khi máy chủ trả `hadActiveSubscription: true` hoặc StoreKit báo đang có gói; `settings.delete.siwa_manual` hiện khi máy chủ trả `siwaManualRevoke: true`.

<!-- Kiểm tra tên các mục Cài đặt trên iPhone tiếng Việt (Đăng ký; Đăng nhập & Bảo mật; Đăng nhập bằng Apple) ở M16. -->
