> **BẢN NHÁP – cần luật sư Việt Nam rà soát trước khi phát hành / DRAFT – requires review by Vietnamese counsel**

# Công bố về việc sử dụng trí tuệ nhân tạo (AI) – RacketCoach

Phiên bản: {{CONSENT_VERSION}} · Có hiệu lực từ: {{EFFECTIVE_DATE}}
Bản tiếng Anh: https://{{LEGAL_HOST}}/en/ai

<!--
Ghi chú (không hiển thị khi xuất bản):
- Căn cứ: Luật Trí tuệ nhân tạo số 134/2025/QH15 (nghĩa vụ ghi nhãn nội dung do AI tạo; theo dõi nghị định hướng dẫn), App Store Review Guideline 5.1.2(i).
- Nguồn kỹ thuật: DESIGN.md D2, D10, §8.1, §8.4, §8.6. Khi đổi mô hình trong model_routes, cập nhật mục 3.
-->

## 1. Tóm tắt

RacketCoach dùng AI để viết nhận xét về kỹ thuật của bạn. Mọi kết quả đều có dòng chữ **"Nhận xét do AI tạo, có thể chưa chính xác"**. Kết quả chỉ để tham khảo khi luyện tập, **không phải lời khuyên y tế** và không thay thế huấn luyện viên.

## 2. Ai làm gì trong một lần phân tích

| Bước | Thực hiện bởi | Việc làm |
|---|---|---|
| Nhận diện tư thế | iPhone của bạn (Apple Vision) | Tìm vị trí 19 khớp cơ thể trong từng khung hình. Video không rời khỏi iPhone |
| Che và làm mờ | iPhone của bạn | Che những người không phải người đánh; làm mờ khuôn mặt ở mức tốt nhất có thể; cắt tối đa 5 ảnh tĩnh |
| Đo đạc và chấm điểm | Máy chủ của chúng tôi (mã lập trình cố định) | Tách từng cú đánh, đo góc, độ cao, tốc độ, so với thang chấm; **mọi con số và điểm số đều do mã tính** |
| Nhận xét | **Claude** (AI của Anthropic PBC, Hoa Kỳ) | Đánh giá những điểm chỉ thấy được qua ảnh (ví dụ hướng mặt vợt) theo thang 0–4 hoặc "không đánh giá được"; chọn điểm mạnh, điểm cần cải thiện **từ các dấu hiệu đã đo được**; viết lời nhận xét, mẹo và kế hoạch tập bằng ngôn ngữ bạn chọn |
| Kiểm tra lại | Máy chủ của chúng tôi | Loại bỏ nhận xét không có dấu hiệu đo được đi kèm, xoá con số trong lời văn của AI, lọc thuật ngữ y khoa, gắn ghi chú an toàn cố định |
| Thiết kế thang chấm | Con người | Thang chấm và bài tập được soạn từ tài liệu huấn luyện, hiệu chỉnh trên video thật có huấn luyện viên đánh dấu |

## 3. Mô hình AI được dùng

| Loại phân tích | Mô hình | Khi nào |
|---|---|---|
| Phân tích nâng cao | Claude Sonnet 5.5 | Premium; 5 phân tích đầu của thời gian dùng thử; phân tích miễn phí đầu tiên |
| Phân tích cơ bản | Claude Haiku 5.5 | Các phân tích miễn phí còn lại; phân tích dùng thử sau 5 lượt nâng cao |

Chúng tôi có thể đổi phiên bản mô hình để cải thiện chất lượng hoặc chi phí; trang này sẽ được cập nhật khi đó.

## 4. Dữ liệu gửi cho AI

Với mỗi phân tích, chúng tôi gửi cho Anthropic: bảng số liệu đã đo từ dữ liệu tư thế, **tối đa 5 ảnh tĩnh** (khuôn mặt đã làm mờ ở mức tốt nhất có thể, người khác đã bị che), môn, kỹ thuật, tay thuận, trình độ và góc quay. **Không gửi video**, email, năm sinh hay mã người dùng. Nếu người trong video dưới 16 tuổi, **không có ảnh nào được gửi**; AI chỉ nhận số liệu tư thế.

Theo chính sách hiện hành của Anthropic, dữ liệu gửi qua API được tự động xoá trong vòng 30 ngày (tối đa 2 năm nếu bị hệ thống an toàn gắn cờ vi phạm chính sách sử dụng) và **không được dùng để huấn luyện mô hình**. Chúng tôi chỉ gửi dữ liệu sau khi bạn đồng ý; bạn có thể rút lại đồng ý trong **Cài đặt › Quyền riêng tư**.

## 5. Giới hạn bạn cần biết

- Ứng dụng chỉ thấy cơ thể dưới dạng 2D từ **một** máy quay. Một số điểm không đo được từ một số góc quay; khi đó ứng dụng ghi rõ "Không đánh giá được từ video".
- Thời điểm chạm cầu hoặc bóng là **ước tính** từ tốc độ cổ tay.
- Điểm số đang ở giai đoạn **beta**, được làm tròn đến 5 điểm. Không so sánh điểm giữa những người khác nhau hay giữa các góc quay khác nhau.
- AI có thể nhận xét sai, nhất là với video tối, xa hoặc bị che. Hãy đối chiếu với cảm nhận của bạn và hỏi huấn luyện viên khi cần.
- AI không chẩn đoán chấn thương hay bệnh lý. Nếu thấy đau, hãy dừng tập và hỏi huấn luyện viên hoặc chuyên gia.
- Kết quả không dùng để ra quyết định nào ảnh hưởng đến quyền lợi pháp lý của bạn, và không dùng cho quảng cáo.

## 6. Ngôn ngữ

AI viết nhận xét bằng ngôn ngữ bạn chọn khi gửi phân tích (tiếng Việt hoặc tiếng Anh). Nếu sau đó bạn đổi ngôn ngữ ứng dụng, nhận xét cũ vẫn giữ ngôn ngữ ban đầu và ứng dụng sẽ ghi chú điều đó.

## 7. Góp ý và báo lỗi

Mỗi kết quả có nút đánh giá hữu ích/không hữu ích. Nếu thấy nhận xét sai hoặc không phù hợp, hãy gửi email đến {{CONTACT_EMAIL}}. Góp ý của bạn giúp chúng tôi điều chỉnh thang chấm và cách AI nhận xét.
