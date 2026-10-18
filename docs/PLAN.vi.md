# Kế hoạch: RacketCoach – App iPhone phân tích kỹ thuật cầu lông & pickleball bằng AI (MVP)

> Tên tạm "RacketCoach", bundle ID `com.<company>.racketcoach`, đổi được sau.
> Bản đặc tả đầy đủ khoảng 100K ký tự, gồm thuật toán, SQL, schema và phần phản biện, nằm tại
> `/tmp/claude-0/-home-user/5763de0e-dfa6-5efd-bb66-dcb23248da78/tasks/w6oxzjggj.output` (`result.finalPlan` + `result.critiques`).
> Bước 0 khi triển khai sẽ chép nó vào repo thành `docs/DESIGN.md` và `docs/design-review.md`. Kế hoạch này là bản rút gọn để thực thi.

## Bối cảnh

Người mới chơi cầu lông và pickleball ít có HLV xem kỹ thuật cho mình. App cho phép quay hoặc tải lên 1 clip khoảng 3–30 giây về **một loại cú đánh**, của chính mình hoặc người khác (người đó phải đồng ý). Quy trình xử lý:

1. iPhone trích khung xương 2D bằng Apple Vision. Vision có **19 khớp**, không phải 33 như MediaPipe.
2. Server Supabase làm sạch dữ liệu, tách từng cú đánh và đo các chỉ số như góc khuỷu, điểm chạm, tư thế, bước chân.
3. Claude nhận xét bằng tiếng Việt hoặc tiếng Anh. Kết quả gồm:
   - **1 lỗi cần sửa trước tiên**, kèm cue và bài tập;
   - điểm tổng và 6 điểm thành phần (gắn nhãn beta);
   - điểm mạnh và điểm yếu, mỗi ý có bằng chứng là khung hình kèm skeleton;
   - kế hoạch tập 3 bước.

Thu tiền bằng thuê bao tháng và năm qua StoreKit 2, theo mô hình freemium. Giai đoạn 1 chỉ mở App Store Việt Nam, giai đoạn 2 mở quốc tế.

Bạn đã chốt các lựa chọn: native SwiftUI, phân tích kiểu hybrid (pose chạy trên máy, AI chạy trên cloud), backend Supabase, và làm MVP code đầy đủ cho 2 môn với 2 ngôn ngữ.

Kế hoạch đã qua 4 nhánh nghiên cứu, 1 bước tổng hợp kiến trúc và 2 vòng phản biện độc lập (kỹ thuật; App Store/kinh doanh). Mọi lỗi mức blocker và major đều đã được xử lý.

**Giới hạn môi trường (đã kiểm tra):**

| Có / không có | Hệ quả |
|---|---|
| Container Linux, **không có Swift toolchain, không có Docker** | Code Swift viết ở đây nhưng bạn build bằng Xcode trên Mac; không chạy được `supabase start` |
| Có Node 22, Python 3, **PostgreSQL 16** | Chạy được test SQL trên cluster tạm |
| npm truy cập được (`deno@2.9.6`, `@anthropic-ai/sdk`) | Deno chạy qua `npx` |

Vì vậy **mọi thuật toán chạy được trên server đều viết bằng TypeScript**. Phần này test được đầy đủ trong container và sửa nóng được mà không cần App Review. Swift chỉ giữ phần dùng API của Apple, UI và phần logic thuần (`CoachCore`).

## Quyết định chính

| Chủ đề | Quyết định |
|---|---|
| Pipeline | **Trên máy:** decode → Vision pose → bám theo người chơi → kiểm tra chất lượng → gửi `pose.v1`.<br>**Server (TS):** làm sạch → resample → tách cú đánh → chia pha → đo chỉ số → chấm điểm → chọn khung hình.<br>**Trên máy (tiếp):** trích 5 khung hình (làm mờ mặt, che người khác) → upload → Claude |
| Ai sinh con số | **Code sinh mọi con số.** Claude chỉ chấm các checkpoint chỉ đánh giá được bằng mắt (thang 0–4), chọn điểm yếu từ danh sách ứng viên có căn cứ, và viết lời nhận xét không chứa số |
| Skill lúc ra mắt | **6 skill**: cầu lông gồm phông cầu thuận tay, đập cầu, giao cầu thấp trái tay; pickleball gồm giao bóng, dink, drop cú thứ ba.<br>Thêm skill mới bằng dữ liệu rubric phía server, không cần cập nhật app |
| Khung hình gửi đi | 5 ảnh (ready, cuối vung tay, chạm, kết thúc động tác, toàn cảnh), 768px, JPEG.<br>Video gốc **không bao giờ upload**; ảnh bị xoá sau khi phân tích xong |
| Model | Free dùng `claude-haiku-5-5`; lần phân tích đầu tiên, Premium và trial dùng `claude-sonnet-5-5` với effort `low`.<br>Structured output theo JSON schema riêng từng môn; system rubric được prompt-cache |
| Job bất đồng bộ | `submit` trả 202 rồi chạy `EdgeRuntime.waitUntil`, mỗi lần gọi chỉ 1 lần gọi Claude.<br>Có pg_cron + pg_net quét job treo, khoá có fencing 8 phút.<br>Client poll trạng thái |
| Tài khoản | Đăng nhập **ẩn danh** của Supabase ngay khi mở app, không bắt đăng ký.<br>Tuỳ chọn liên kết Sign in with Apple hoặc email OTP; có `account-merge` khi danh tính đã tồn tại |
| Thuê bao | Nhóm "Premium" gồm `…premium.monthly` và `…premium.yearly`; trial 7 ngày chỉ cho gói năm.<br>Server là nguồn sự thật, xác minh qua App Store Server API; `appAccountToken` = UUID người dùng (viết thường); webhook ASSN v2 |
| Giá VN | **79.000₫/tháng**, **599.000₫/năm**.<br>Quốc tế (giai đoạn 2): $9.99 / $59.99, giá riêng cho thị trường SEA và Ấn Độ |
| Quota (server kiểm soát) | Free: 2 lượt/tháng; lượt đầu tiên dùng Sonnet; báo cáo bị khoá một phần.<br>Trial: 10 lượt (5 Sonnet).<br>Premium: 15 lượt/tháng thuê bao. |
| Chi phí AI ước tính | Sonnet: khoảng $0.047–0.063/lượt (1.200–1.650₫).<br>Haiku: khoảng $0.004/lượt.<br>Lãi gộp ước khoảng 36% ở trường hợp xấu nhất của gói năm VN.<br>Ngân sách ngày có cảnh báo; người dùng trả phí không bao giờ bị chặn |
| Ngôn ngữ | String Catalog vi + en.<br>Mặc định tiếng Việt khi App Store hoặc vùng máy là VN; đổi được trong app |
| Nền tảng | iOS 17+, chỉ iPhone, giao diện dọc, XcodeGen (`project.yml`), supabase-swift được ghim phiên bản |
| Độ tuổi | Người dùng 18+ lúc ra mắt (giá trị cấu hình được).<br>Nếu quay người dưới 16 tuổi: chỉ phân tích bằng pose, không gửi ảnh |

## Luồng người dùng (đến kết quả đầu tiên trong khoảng 7 lần chạm)

1. **Welcome:** chọn ngôn ngữ, xem phân tích mẫu offline.
2. **Về bạn:** năm sinh, tay thuận, trình độ.
3. **Home:** nút "Phân tích cú đánh", chip quota còn lại.
4. **Tạo phân tích:**
   - chọn skill → hướng dẫn đặt máy quay;
   - nguồn video: quay trong app (có kiểm tra khung hình theo đèn xanh/đỏ, 60fps, tối đa 30s), Photos, Files, hoặc "Mở bằng RacketCoach" từ Zalo;
   - cắt đoạn 3–30s;
   - chọn "Tôi" hoặc "Người khác" (cần xác nhận đồng ý);
   - chạm chọn người chơi nếu khung hình có nhiều người.
5. **Đồng ý xử lý dữ liệu** (hiện đúng lúc cần): xử lý và chuyển dữ liệu ra nước ngoài (Supabase Singapore, Anthropic Mỹ) theo PDPL. Có thể rút lại trong Settings.
6. **Đang xử lý:** đọc video → nhận diện tư thế → phân tích → màn "Xác nhận cú đánh" (bỏ tick các cú sai, xác nhận góc quay).
7. **Kết quả:**
   - "Sửa điều này trước";
   - vòng điểm (beta) và 6 thanh điểm thành phần;
   - điểm mạnh / cần cải thiện, chạm vào để xem khung hình kèm skeleton;
   - kế hoạch tập;
   - mục "không đánh giá được";
   - nhãn "Nhận xét do AI tạo…".

   Người dùng free chỉ thấy phần đầu, phần còn lại khoá kèm số lượng.
8. **Lịch sử, Tiến bộ** (biểu đồ, Premium), **Paywall** (`SubscriptionStoreView`), **Settings** (tài khoản, thuê bao/khôi phục, ngôn ngữ, quyền riêng tư, **xoá tài khoản**).

## Cấu trúc repo `/home/user/racketcoach` (git init)

```
scripts/        check.sh, gen-schemas.ts, gen-synthetic-pose.ts, replay.ts, bench-engine.ts,
                fit-contact-offsets.ts, eval.ts, smoke-claude.ts, warm-schemas.ts, gen-test-certs.sh, check_ios_resources.py
tools/labeler/  index.html (gắn nhãn thời điểm chạm cầu cho clip thật)
shared/         schemas/*.json (sinh từ Zod) · fixtures/{pose,labels,prepare,claude,results}
ios/            project.yml · Config/*.xcconfig · RacketCoach/{App,Features/*,Services/*,DesignSystem,Resources}
                RacketCoachTests/ · Packages/CoachCore (Swift 6, chỉ Foundation) · Tools/PoseDump (CLI macOS → pose.v1)
supabase/       config.toml, seed.sql, migrations/0100_core…0900_cron.sql
                functions/{analyze,cron,verify-subscription,appstore-webhook,apple-auth-exchange,account-merge,delete-account}
                functions/_shared/{contracts,rubric,engine,claude,jobs,apple,…} · tests/{engine,claude,apple,jobs,functions,rubric,sql}
docs/           DESIGN.md, design-review.md, camera-guide.{vi,en}.md, glossary.md, legal/*, appstore/*, support/*, economics.md
```

## Các thành phần chính

Chi tiết từng thành phần nằm trong `DESIGN.md`, các mục §5–§10.

- **iOS app:**
  - `AppModel` dùng `@Observable`, các dependency là protocol nên mock được.
  - Capture: `AVCaptureSession` 60fps HEVC, không thu âm, có live framing; import qua PhotosPicker, `.fileImporter`, `CFBundleDocumentTypes`; xuất passthrough.
  - `CompositionFrameReader`: Rec.709 (xử lý được video HDR), khung hình dựng thẳng, PTS tính bằng µs.
  - `VisionPoseEstimator` dùng ROI theo tracker.
  - `AnalysisPipeline`: `AsyncThrowingStream`, có checkpoint khi app vào nền.
  - `KeyFrameExtractor` và `PrivacyMasker`: làm mờ mặt, pixelate người không phải mục tiêu, fail-closed.
  - `AnalysisAPI`, `StoreService` (StoreKit 2), `AccountLinker`, `LocalAnalysisStore`.
  - Màn kết quả: `HeroFixCard`, `ScoreRing`, `KeyFrameView`, …
- **CoachCore (Swift thuần):** `IDs.lower`, `Joint` (19 khớp), `RoiMapper`, `FrameScheduler` (xử lý được video VFR), `Tracker` (IoU + tâm, coast 0.5s), `QualityGate`, `PoseV1Builder` / `Quantizer`, `CropMath`, `SkeletonGeometry`. Có test bằng swift-testing, đọc fixture dùng chung.
- **Engine (TS, `_shared/engine`):**
  - Làm sạch theo thứ tự: chuẩn hoá theo chiều dài thân T → sửa hoán đổi trái/phải → Hampel trên phần dư → resample + lấp khoảng trống → lọc Savitzky–Golay.
  - Tách cú đánh: đỉnh tốc độ cổ tay vượt ngưỡng Vmin, lọc NMS theo skill, cộng offset thời điểm chạm fit từ nhãn của HLV.
  - Pha: ready / bsEnd / contact / ftStop; đo chỉ số theo góc quay S/B/D; đoán góc quay và tay thuận.
  - Chấm điểm: 6 điểm thành phần theo trọng số rubric, đủ coverage mới hiện, làm tròn đến 5.
  - Chọn ứng viên điểm mạnh/yếu và lập kế hoạch khung hình.
- **Rubric (`_shared/rubric/*.json`):** skill, checkpoint, ngưỡng, lỗi thường gặp, khoảng 30 bài tập song ngữ, mẫu câu dễ hiểu và mẹo luật chơi. Có test toàn vẹn (trọng số cộng đủ 100, mọi lỗi đều có bài tập, có đủ vi/en).
- **Claude (`_shared/claude`):**
  - System gồm `BASE_SYSTEM` + `RUBRIC_TEXT[sport]` (cache).
  - Nội dung user gồm 5 ảnh + các khối `<session>/<checkpoints>/<strokes>/<candidates>/<visual_to_judge>` + "Output language: vi|en".
  - Đầu ra theo `output_config.format` với JSON schema riêng từng môn, enum đặt trong `$defs`.
  - `runOnce` xử lý kết quả: thành công / refusal / max_tokens / lỗi parse / 429-5xx thì requeue, có hoàn quota.
  - `postprocess`: chuẩn hoá enum, lọc bằng chứng không có căn cứ, xoá con số trong lời nhận xét, ép đưa lỗi lớn nhất vào kết quả, lọc thuật ngữ y tế (NFC + ranh giới Unicode), ghép điểm.
- **Postgres:**
  - Bảng: `profiles`, `analyses`, `analysis_results` (client không đọc trực tiếp), `plan_limits`, `model_routes`, `entitlements`, `app_store_subscriptions`, `usage_counters`, `quota_ledger`, `feedback`, `events`, `app_config`, `enabled_skills`, cùng schema `private.*` (llm_calls, notifications, audit…).
  - Hàm `reserve_for_submit` dùng advisory lock, `claim`/`finalize` có fencing, `get_result` lọc nội dung theo gói, `my_status`, `get_history`, `get_progress`, `log_event`.
  - RLS cho mọi bảng, cấp quyền theo cột; Storage chia 2 bucket, mỗi người dùng chỉ truy cập thư mục của mình.
- **Apple (`_shared/apple`):**
  - JWT ES256, App Store Server API (host `api.storekit[-sandbox].apple.com`), Set App Account Token, Send Consumption Information, xác minh chuỗi JWS (Apple Root CA G3).
  - Chính sách liên kết thuê bao: khi người dùng bấm Khôi phục, tài khoản khôi phục sau cùng được nhận gói, có rate-limit.
  - Webhook chỉ hạ quyền khi trạng thái lấy lại từ Apple xác nhận.

## Thứ tự triển khai trong phiên này (Linux)

Dùng Workflow để code song song theo từng module; mỗi milestone đều chạy `scripts/check.sh`.

0. **Tạo repo:**
   - `git init /home/user/racketcoach`;
   - chép đặc tả vào `docs/DESIGN.md` và `docs/design-review.md`;
   - chép bảng chi phí đã kiểm chứng vào `docs/costs.md`;
   - README cài đặt cho Mac.
1. **M0 – Scaffold:** cây thư mục, `deno.json` (ghim npm: `@anthropic-ai/sdk`, `zod@4`, `@supabase/supabase-js@2`, `jose@6`, `@peculiar/asn1-x509`), `config.toml`, `project.yml`, `check.sh`, `check_ios_resources.py`.
2. **M1 – Data contracts:** Zod cho `pose.v1`, `reprepare.v1`, `prepare.v1`, `coach.v1` (theo từng môn) và `coach-result.v1` → sinh `shared/schemas`. Có audit từ khoá không được structured output hỗ trợ.
3. **M2 – Rubric:** 6 skill bật, 6 skill tắt sẵn, khoảng 30 drill, text song ngữ, test toàn vẹn.
4. **M4a–d – Engine:** làm sạch, tách cú đánh, chỉ số, chấm điểm, kế hoạch khung hình, `prepare`. Test bằng pose tổng hợp (có VFR, tốc độ thật 20–30 T/s); bench dưới 300ms.
5. **M5 – SQL:** migration 0100–0900 + seed. Test trên stack Supabase local thật (Docker, `supabase/tests/sql/run.sh`: pgTAP + script shell): RLS, cấp quyền theo cột, chạy đồng thời `reserve_for_submit`, fencing, hoàn quota.
6. **M6 – Claude:**
   - Nạp skill `claude-api` trước để **kiểm tra lại** model ID, giá, `output_config`/effort, prompt caching và các giới hạn schema.
   - Viết prompt, request builder, `runOnce`, postprocess, test với mock.
   - Smoke test thật (khoảng $0.50) **chỉ chạy khi bạn duyệt và cung cấp API key**.
7. **M7 – Hàm `analyze`** (`catalog`/`prepare`/`submit`/`run`) + `cron` + budget guard + migration 0900. Test handler với fake.
8. **M8 – Thuê bao Apple:** `verify-subscription` + `appstore-webhook`. Test chuỗi cert sinh bằng openssl và ma trận các trường hợp liên kết.
9. **M9 – Tài khoản:** `apple-auth-exchange`, `account-merge`, `delete-account` (xoá đệ quy, idempotent), DeviceCheck.
9b. **Dev stack:** `Makefile`, `scripts/dev.sh`, `docker-compose.yml`, `.env.example`, chế độ `CLAUDE_MODE=mock`, sinh `Local.xcconfig`. Ngay sau đó là **Web Lab** (`weblab/`): MediaPipe → pose.v1, luồng prepare/submit/result, tab Labeler. Có unit test, `vite build` và chạy headless bằng Chromium.
10. **M3 + M11 – Swift `CoachCore` + `PoseDump`:** viết code và test (không biên dịch được ở đây). `replay.ts` chạy lại fixture qua engine.
11. **M10, M12–M15 – iOS app:** shell, xác thực ẩn danh, l10n, xcprivacy, consent; capture; pipeline; masker; kết quả; lịch sử/tiến bộ; player; StoreKit/paywall. Dữ liệu cho SwiftUI Preview lấy từ fixture.
12. **M16 – Settings, demo và tài liệu:** hướng dẫn quay; chính sách quyền riêng tư, Terms/EULA, công bố AI (vi/en); metadata App Store; review notes; privacy label; trang hỗ trợ; `economics.md`.
13. **Đóng gói:** commit; push nếu bạn cung cấp repo GitHub, nếu không thì gửi file `.tar.gz` qua SendUserFile, vì container sẽ bị thu hồi.

Không làm được trong container này:

| Việc | Lý do / cách xử lý |
|---|---|
| Build Swift | Không có toolchain; bạn build trên Mac |
| S1 deploy spike lên Supabase thật | Domain supabase.com không truy cập được từ container |
| Hiệu chỉnh trên clip thật (M17) | Cần clip quay thật và HLV gắn nhãn |
| Gọi Claude thật | Cần bạn duyệt và cung cấp key |

## Chạy local trên MacBook Air M4 + iPhone 11 Pro (Docker)

App iPhone chạy bằng Xcode, trên Simulator hoặc trên iPhone 11 Pro. Docker chỉ dựng **backend local**: app không chạy trong Docker được, vì iOS chỉ chạy trên macOS.

**Docker (Supabase local stack):**
- Cần Docker Desktop (miễn phí cho cá nhân/doanh nghiệp nhỏ) hoặc OrbStack/Colima.
- `supabase start` dựng Postgres, Auth, Storage, Edge Runtime, Studio (http://localhost:54323), Inbucket (xem email OTP) và pg_cron.
- `supabase/config.toml`:
  - bật `enable_anonymous_sign_ins`;
  - `[edge_runtime] policy = "per_worker"`;
  - mẫu email OTP có `{{ .Token }}`.
- `supabase db reset` chạy migrations + `seed.sql`. Seed gồm plan_limits, model_routes, app_config và tài khoản reviewer mẫu.

**Lệnh một chạm `make dev`** (có thêm `scripts/dev.sh`):
1. Kiểm tra Docker đang chạy.
2. `npx supabase start` rồi `db reset`.
3. Sinh `supabase/functions/.env.local` từ `.env.example`.
4. `supabase functions serve`.
5. In ra URL và anon key, rồi ghi `ios/Config/Local.xcconfig`, gồm host `127.0.0.1` cho Simulator và IP LAN của Mac cho iPhone.

Các lệnh khác: `make stop`, `make reset`, `make test` (tức `scripts/check.sh`), `make logs`.

**Chế độ AI:**
- `CLAUDE_MODE=mock` (mặc định local): trả kết quả dựng từ fixture và danh sách ứng viên thật, **miễn phí**, thử được toàn luồng.
- `CLAUDE_MODE=live` + `ANTHROPIC_API_KEY`: gọi Claude thật.

**Apple khi chạy local:**
- Thuê bao test bằng file `Products.storekit` trong Xcode, server bật `ALLOW_XCODE_ENV=true`.
- Đăng nhập ẩn danh chạy ngay.
- Sign in with Apple chỉ chạy khi đã cấu hình key thật (tuỳ chọn).

**Web Lab** (`weblab/`, Vite + TypeScript, có service `weblab` trong `docker-compose.yml` ở http://localhost:5173):
- Upload video, nhận diện pose bằng **MediaPipe Pose Landmarker** (WASM, chạy trong trình duyệt).
- Map 33 landmark sang 19 khớp chuẩn Vision (neck/root lấy trung điểm), dựng `pose.v1`.
- Gọi `/analyze/prepare`, rồi render key frame bằng canvas, upload, `submit`, poll.
- Hiển thị kết quả giống app: hero, điểm, bằng chứng, skeleton.
- Có thêm tab **Labeler**: gắn nhãn thời điểm chạm cầu cho clip thật, xuất CSV (thay cho `tools/labeler`).

Mục đích: thử nhanh thuật toán và prompt trên laptop không cần build app; hiệu chỉnh với HLV. Pose từ MediaPipe khác Vision một chút, nên chỉ dùng cho dev, không thay app.

**Xcode** (cấu hình Debug):
- Scheme `RacketCoach-Local` đọc `Local.xcconfig`.
- ATS dùng `NSAllowsLocalNetworking` và có `NSLocalNetworkUsageDescription`, **chỉ ở Debug**.
- Release dùng project Supabase thật.

**Checklist trong README:**
1. Cài Xcode 26.x, `brew install xcodegen`, Docker Desktop.
2. `make dev`, `xcodegen generate`, mở `RacketCoach.xcodeproj`.
3. Chạy trên Simulator (import video mẫu vào Photos).
4. Chạy trên iPhone 11 Pro:
   - bật Developer Mode;
   - ký bằng Apple ID cá nhân (Personal Team, miễn phí, app hết hạn sau 7 ngày) hoặc bằng tài khoản Developer đã trả phí.

**Kiểm tra:** container này không có Docker nên không chạy thử `make dev` được. Mình kiểm tra được:
- cú pháp `docker-compose.yml` và `config.toml`;
- shellcheck cho `dev.sh`;
- unit test của Web Lab, gồm map MediaPipe sang `pose.v1`;
- `vite build`;
- Web Lab chạy headless bằng Chromium trên một video mẫu, nối với backend mock.

Bạn chạy `make dev` trên Mac để xác nhận lần cuối.

## Kiểm thử

**Trong container (`scripts/check.sh`):**
- `deno fmt/lint/check`;
- `deno test` cho engine, rubric, contracts, claude (mock), jobs, apple, functions;
- `gen-schemas --check`;
- `replay.ts --mock-claude` chạy end-to-end từ pose đến kết quả;
- `bench-engine`;
- `supabase/tests/sql/run.sh` (stack Supabase local qua Docker, có test đồng thời; `check.sh` bỏ qua kèm thông báo khi không có Docker);
- `check_ios_resources.py`: kiểm tra xcstrings đủ vi/en, xcprivacy, Info keys, xcconfig, ID sản phẩm StoreKit.

**Trên Mac/iPhone (bạn làm, có checklist trong README):**
1. `brew install xcodegen && xcodegen generate`, build, chạy `swift test` cho CoachCore, chạy `swift run posedump`.
2. Tạo project Supabase Pro ở ap-southeast-1; bật anonymous sign-in, manual identity linking và Apple; chạy `supabase db push`; cài secrets; `functions deploy`; làm spike S1.
3. Test StoreKit trong Xcode bằng file `.storekit`, rồi test sandbox trên máy thật.
4. Thiết bị thật (iPhone 11 và máy A17+):
   - tốc độ pose;
   - clip bị lật gương và clip HDR;
   - mức độ làm mờ mặt;
   - tiếp tục xử lý sau khi app vào nền;
   - chữ tiếng Việt ở cỡ chữ lớn.
5. TestFlight với 5–10 người chơi VN và 1 HLV.

## Rủi ro chính và cách giảm

| Rủi ro | Cách giảm |
|---|---|
| Pose 2D từ 1 camera không chính xác, cổ tay ở tốc độ đập cầu dễ mất | 60fps, live framing, ROI, ngưỡng kích thước người, điểm làm tròn + nhãn beta, coverage |
| Không nhận diện được vợt và cầu | Thời điểm chạm là ước lượng hiệu chỉnh từ nhãn thật; Claude đánh giá bằng mắt từ khung hình |
| AI bịa nhận xét | Code sinh mọi con số; chỉ chọn từ ứng viên; xoá số khỏi lời nhận xét; enum theo môn; postprocess |
| Chi phí | Ước tính trên, kiểm soát bằng quota, Haiku cho gói free, ngân sách ngày |
| Bị App Review từ chối | Checklist trong `DESIGN.md` §11 (3.1.2, 4.8, 5.1.1(v), 5.1.2, privacy manifest) |
| Pháp lý VN | PDPL / Nghị định 356, luật AI, luật về lưu trữ dữ liệu trong nước: có gate G1/G2 cần luật sư |

## Chi phí dự kiến (kịch bản của bạn: đã có MacBook Air M4 + iPhone 11 Pro)

Số liệu đã qua 1 vòng kiểm chứng ngày 18/10/2026, tỷ giá 26.000₫/USD. Bảng đầy đủ kèm nguồn nằm trong output workflow `/tmp/claude-0/-home-user/5763de0e-dfa6-5efd-bb66-dcb23248da78/tasks/w97lh81bl.output` (`result.verified`) và sẽ được chép thành `docs/costs.md`.

**Bắt buộc:**

| Khoản | Chi phí |
|---|---|
| Apple Developer Program (Individual) | $99/năm ≈ 2.574.000₫ |
| Supabase | Free khi dev; Pro $25/tháng ≈ 650.000₫ từ lúc ra mắt |
| Domain .com | ≈ 272–290K₫/năm. Nên mua trước 1/11/2026 vì từ đó tăng giá |
| Claude API | Nạp trước $5–20 |
| Xcode, TestFlight, StoreKit, Sign in with Apple, Docker Desktop (cá nhân), Cloudflare Pages, Resend Free | 0₫ |

**Hoa hồng và thuế Apple:**
- Đăng ký **Small Business Program trước khi bán** để chịu 15% thay vì 30%.
- Với dev cá nhân VN, Apple tự khấu trừ VAT, PIT 2% và FCT.
- Thực nhận từ gói 79K/tháng khoảng 59–62K₫.

**Chi phí AI mỗi lượt phân tích:**
- Haiku 5.5 ≈ 40–73₫.
- Sonnet 5.5 ≈ 780–1.450₫.

Thiết kế của mình chỉ cho user free dùng Sonnet ở lần phân tích đầu tiên, nên ở mức 1.000 MAU chỉ cần khoảng 2% user trả phí là hoà vốn vận hành.

**Tổng ngân sách:**

| Mốc | Chi phí |
|---|---|
| Tối thiểu lên TestFlight | ≈ 2,7 triệu₫ |
| Tối thiểu lên App Store VN (tháng đầu) | ≈ 3,4–4,0 triệu₫ |
| 6 tháng, bản tiết kiệm | ≈ 57 triệu₫, phần lớn là tư vấn PDPL ~15tr, marketing ~20tr, nhãn hiệu ~2,8tr, HLV ~6tr, icon ~1,3tr |
| 6 tháng, bản đầy đủ | ≈ 139 triệu₫ |

Nếu lập công ty TNHH thì cộng thêm khoảng 6,6–16,7 triệu₫ cho 6 tháng (chữ ký số, kế toán, dịch vụ thành lập).

Tuỳ chọn: icon, Figma/Sentry, MacStadium/Codemagic (không cần vì bạn đã có Mac).

**Điều chỉnh thiết kế rút ra từ đợt tra cứu này:**
- **Thinking trên Sonnet 5.5:** `{type:"disabled"}` trả lỗi 400. Dùng adaptive + effort `low` (hoặc `between_tools`); Haiku 5.5 đặt effort tường minh.
- **Bật `fallbacks:"default"`** cho Sonnet 5.5.
- **Resize frame về 768px** trước khi gửi.
- **Kiểm tra mức giá 79.000/599.000₫** có trong bảng price point của App Store Connect không.
- **Nộp nhãn hiệu trước 31/12/2026** để còn được giảm 50% lệ phí.
- **iPhone 11 Pro dùng tốt để test** (deployment target iOS 17). Đây cũng là máy "đời thấp" để đo hiệu năng pose.

## Đầu vào cần từ bạn (để sau, không chặn việc viết code)

1. Tên app chính thức vi/en và reverse-DNS của công ty (dùng placeholder cho tới khi có).
2. Repo GitHub để push code. Nếu chưa có, mình gửi file nén.
3. Sau này:
   - project Supabase;
   - Anthropic API key (để chạy smoke test khoảng $0.50);
   - tài khoản Apple Developer (key IAP, SIWA, DeviceCheck);
   - 20–30 clip thật + 1 HLV gắn nhãn;
   - pháp nhân và luật sư trước khi lên TestFlight công khai.
