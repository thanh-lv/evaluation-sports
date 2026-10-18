# Research: market-pricing

> Research output from 2026-10-18 (unverified claims marked inside). DESIGN.md is authoritative.

# Market, competition, pricing and App Store compliance research: AI technique coach for badminton and pickleball (Vietnam-first, VI/EN)

**Legend:** **[V]** = verified (official source, or several consistent sources). **[S]** = one secondary source or a store-listing snippet. **[U]** = unverified, or my own estimate.

**Method note:** WebFetch could not reach apps.apple.com, pb.vision and similar sites from this container (DNS failure and proxy 403). All competitor prices come from search snippets and trackers, so check them in the App Store before quoting them publicly.

---

## 0. Key findings
1. **No Vietnamese-language technique coach exists in either sport [S].** SwingVision supports 9 languages and Vietnamese is not one of them. PB Vision is English-only. Badminton AI apps are small and scattered, and most measure shot speed or tracking rather than coach beginners. The only local competitor found is **"Chấm Trình Pickleball bằng AI"** on the VN App Store. Its developer and pricing are unknown, so look at it before launch.
2. **Incumbents target intermediate players recording whole matches.** They need a tripod, full-court framing and a full video upload, and they charge $15–25/month. A product built for beginners, analysing one stroke at a time, sending only pose data (fast and light on mobile data), covering both sports with drills and priced in VND is an open space.
3. **Unit economics:** at VN prices (79k₫/month ≈ $2.35 after VAT and commission), a Sonnet-class analysis at about $0.07–0.10 is a meaningful cost.
   - The free tier must be small: about 3 welcome analyses, then roughly 1 per month.
   - The free tier should route to Haiku 5.5 (about $0.004 per analysis).
   - Paid tiers need a fair-use cap.
   - The US and international tiers have healthy margins.
4. **Three compliance items are most likely to cause rejection:**
   - **5.1.2(i)**: get explicit consent before sending personal data to a third-party AI, and name Anthropic (in force since Nov 2025).
   - **3.1.2**: paywall disclosures.
   - **5.1.1(v)**: in-app account deletion, including Sign in with Apple token revocation.
   
   Also provide a **demo video or demo mode** so the reviewer can test without a badminton clip.
5. **Vietnam law:** the PDPL (Law 91/2025/QH15) and Decree 356/2025/ND-CP have both applied since 1 Jan 2026 and replace Decree 13. Sending data to Anthropic (US) and Supabase (Singapore/US) is a **cross-border transfer**, which needs a transfer impact assessment dossier filed with the Ministry of Public Security (MPS). Minimise data: blur faces on device, never upload video, store derived features only. Get local counsel review before launch.

---

## 1. Competitors and adjacent apps

| App | Sports | Approach | Price (USD unless noted) | VI? | Beginner technique focus? | Notes |
|---|---|---|---|---|---|---|
| **SwingVision** | Tennis, pickleball | Full-court ball and shot tracking, line calls, highlights, stats. Phone on a tripod at the back of the court | Jul 2026 tracker: Plus $14.99/mo or $95.99/yr; Pro $24.99/mo or $179.99/yr; Max $39.99/mo or $299.99/yr. An older listing showed Pro at $14.99/mo [S] | **No** (EN, FR, DE, IT, JA, KO, PT, ZH, ES) [S] | Partly (stats more than coaching) | Market leader. No badminton. [link](https://apppricinglab.com/iap/apple/989461317), [listing](https://apps.apple.com/us/app/swingvision-tennis-pickleball/id989461317) |
| **PB Vision** | Pickleball | Upload a whole game; cloud CV produces shot stats and an AI DUPR rating | About $1 per 12-minute game (vendor help page) [S]. Entry about $19.99/mo, Premium about $49.99/mo; pricing has changed several times [S]. 1 free analysis for new DUPR users [S] | No | No (match analytics) | Uploads full video, which is heavy on VN mobile data. [help](https://help.pb.vision/articles/9196356-ratings-for-clubs-and-organized-play), [review](https://fitnessaitrends.com/blog/is-pb-vision-worth-it-serious-pickleball-players-2026/), [DUPR](https://www.dupr.com/post/dupr-and-pickleball-vision-partner-to-shape-the-future-of-ai-pickleball-ratings) |
| **OnForm** | Any (coach tool) | Manual video tools (slow-mo, drawing, side-by-side) | Mar 2026 listing: individual $9.99/mo standard, $14.99/mo premium; Coach $29.99/mo; 14-day trial [S] | No | No (coach workflow) | Possible coach-side partner or alternative. [listing](https://apps.apple.com/KR/app/id1490334045) |
| **Sportsbox AI** | Golf, baseball | 3D pose from a single phone, scoring | Free (5 analyses/mo); about $15.99/mo player plan [S] | No | Yes (golf) | **No racket product found.** Shows that single-camera pose scoring sells. [link](https://www.ki-syndikat.de/tools/sportsbox-ai/) |
| **Pickle Sensei** | Pickleball | iPhone, on-device pose, scores dinks and serves, drills, progress tracking | 1 free rating, then Pro $7.99/mo [S] | No | **Yes** | **Closest concept** (launched Oct 2026). Videos stay on device. [PH](https://www.producthunt.com/posts/pickle-sensei) |
| **Spherely** | Tennis, pickleball, padel, **badminton**, table tennis, squash | Rally and highlight detection, stroke analysis | $7.99/mo, $59.99/yr [S] | "Multilingual"; Vietnamese unconfirmed | Partly | Very few ratings. [listing](https://apps.apple.com/app/id6743446008) |
| DinkAI | Pickleball | Shot mechanics feedback | Free plus in-app purchases [S] | No | Yes | 4 ratings. [listing](https://apps.apple.com/us/app/-/id6755826435) |
| Shot AI | Golf, tennis, pickleball | Score plus "what to fix", live camera coaching | Unknown | No | Yes | [listing](https://apps.apple.com/app/surge/id6753973996) |
| **BadProPlus (BADPRO+)** | **Badminton** | CV shot classification (smash, drop, lob), error heat maps, training plans | Unknown | Unknown (Taiwan store) | Partly | [listing](https://apps.apple.com/tw/app/badproplus/id6746172500) |
| Smashspeed | Badminton | Smash speed from video, offline | Unknown | No | No | [link](https://www.smashspeed.ca/) |
| GoodShot | Badminton | Tracks smashes, clears, shot speed | $1.99/mo, $5.99/yr [S] | Unknown | No | [link](https://appshunter.io/ios/app/ai/id1622183934) |
| Court Rally | Badminton, pickleball | Per-clip AI film analysis | $1.99 per analysis [S] | Unknown | Partly | Per-use pricing for reference. [link](https://www.stork.ai/en/court-rally) |
| SportsReflector | 16–20+ sports | Form analysis | Quotes conflict: $19.99/mo, or a $10–149/mo range [S] | Unknown | Yes | [GetApp](https://www.getapp.com/all-software/a/sportsreflector/) |
| Machaxi (India) | Badminton | AI-assisted coaching centres (B2B2C) | n/a | No | Yes | Raised $1.5M. Validates a model built around coaches. [link](https://www.outlookbusiness.com/start-up/investors/machaxi-raises-15-million-to-scale-ai-powered-badminton-coaching-across-india) |
| **Chấm Trình Pickleball bằng AI** | Pickleball | Skill rating, per-shot, movement and tactics feedback, drill suggestions from uploaded video | Unknown [U] | **Yes (VN store)** | Yes | **The only VN-language direct competitor found.** [listing](https://apps.apple.com/vn/app/ch%E1%BA%A5m-tr%C3%ACnh-pickleball-b%E1%BA%B1ng-ai/id6746329845?l=vi) |

**Vietnamese ecosystem (channels or partners, not competitors):**
- **ALOBO**: court-owner booking and POS for badminton, football, tennis and pickleball. 3.7★ from 25 ratings. [listing](https://apps.apple.com/vn/app/id6479625204)
- **Champick**: court booking with a map. [listing](https://apps.apple.com/us/app/id6720738960)
- **D-Pickl (D-Joy)**: booking, tournaments, DUPR. D-Joy runs 76 courts and is DUPR's Asia partner. [listing](https://apps.apple.com/mx/app/d-pickl/id6740696112), [DUPR](https://www.dupr.com/post/dupr-expands-into-asia-with-new-regional-hq-and-deepened-partnership-with-djoy)
- **Pickle Mate**: matchmaking, launching in VN. [PH](https://www.producthunt.com/products/pickle-mate-2/makers)
- **Reclub**: community clinics in Hanoi. [link](https://reclub.co/m/N1OW0X)
- **Booking and community apps have no AI coaching.** That makes them integration and marketing partners.

**The gap this app fills:**
1. Vietnamese-first, bilingual output.
2. Built for beginners: one stroke per clip, any phone angle, no tripod or full-court framing required.
3. Both sports in one app. Many VN players move from badminton to pickleball.
4. Pose-only upload, so analysis is fast, cheap on mobile data and better for privacy.
5. VND pricing well below the $15–25 that incumbents charge.
6. Concrete drills, not just stats.

**Threats:**
- Pickle Sensei or Spherely add Vietnamese (low effort for them).
- SwingVision adds badminton.
- Chấm Trình AI expands to badminton.
- 2D pose accuracy on fast badminton strokes. Mitigate with 60 or 120/240 fps slow-motion capture guidance; feasibility is for the technical researcher [U].

---

## 2. Market signals (brief)

| Signal | Data | Grade |
|---|---|---|
| US pickleball | **24.3M players in 2025, +22.8% YoY** (4.2M in 2020). Ages 13–24 have the highest participation rate; women are 42.9% of players. SFIA 2026 report | [V] [SFIA](https://sfia.org/research/u-s-pickleball-participation/), [pickleball.com](https://pickleball.com/news/sfia-report-confirms-over-24-million-americans-playing-pickleball) |
| VN pickleball spend | E-commerce gear sales of **VND 511bn in H1 2025, about 13× YoY**. Q1 2025 was VND 229bn (19×). Source: Metric.vn | [V] [VietnamNews](https://vietnamnews.vn/economy/1722845/vietnamese-shoppers-spend-20-million-on-pickleball-gear-in-just-six-months.html), [baovanhoa](https://baovanhoa.vn/kinh-te/nguoi-viet-chi-hon-nua-nghin-ty-dong-mua-do-pickleball-trong-nua-nam-2025-159717.html) |
| VN players | Estimates vary widely: about 30k (Tuổi Trẻ, Mar 2025) versus a disputed "16M" (UPA Asia/YouGov extrapolation, which Tuổi Trẻ debunked in Nov 2025). Awareness is about 88%, +152% vs 2023. Use "several million" at most | [S] [Tuổi Trẻ](https://tuoitre.vn/thuc-hu-chuyen-16-trieu-nguoi-viet-nam-choi-pickleball-20251126222523254.htm), [UPA Asia](https://upa-asia.com/asia-the-next-frontier-research-released/) |
| VN on DUPR | Top 3 to top 5 country by DUPR users (DUPR, 2026). +184% growth in 2025. DUPR opened its Asia HQ in HCMC (Apr 2026) | [S], self-reported [DUPR](https://www.dupr.com/post/dupr-expands-into-asia-with-new-regional-hq-and-deepened-partnership-with-djoy) |
| VN events | Pickleball World Cup 2026 in Da Nang (66 nations, 97 courts). PPA Asia Vietnam Open, Sept 2025 (354 players) | [S] [link](https://pickleballspot.eu/en/news/pickleball-world-cup-2026-da-nang-nations-groups/) |
| VN court prices | HCMC 100k–300k₫/hour (peak 300k) | [S] [SGGP](https://www.sggp.org.vn/nhon-nhip-thi-truong-pickleball-post766602.html) |
| Badminton globally | BWF: **384M active players**, 744M fans (+65%, Dec 2025). The 339M figure is from the 2018 study | [V] [BWF](https://bwfbadminton.com/news-single/2025/12/09/bwf-and-infront-extend-partnership-to-drive-badmintons-next-era-of-global-growth/) |
| Badminton in VN and SEA | Q&Me: badminton is the **most actively played** sport in VN (no headcount given). Hakuhodo 2016: badminton is the top activity across 15 Asian cities (32%) | [S] [Q&Me](https://qandme.net/vi/baibaocao/so-thich-the-thao-va-van-dong-vien-duoc-yeu-thich-tai-viet-nam.html), [Hakuhodo](https://www.hakuhodo-global.com/wp_admin/wp-content/uploads/2017/09/20160329.pdf) |
| iOS share in VN | Android first, iOS second (StatCounter via Statista; exact figures paywalled; often quoted at about 30–35%) | [U] [Statista](https://www.statista.com/statistics/928956/vietnam-mobile-os-market-share/) |

**Implication:** iOS-first fits VN pickleball well, because the sport is urban and higher-income. Mass-market VN badminton will need Android later.

---

## 3. Pricing recommendation

### 3.1 Price ladder (set per storefront manually; do not let Apple auto-convert $9.99 into about 260k₫)
VND price points must be picked from the App Store Connect price picker. Check that each value below exists [U].

| Plan | Vietnam | US / international | Rationale |
|---|---|---|---|
| Free | 3 welcome analyses, then 1 per month (routed to Haiku) | Same | Lets users see the value without exposing much AI cost |
| Monthly | **79,000₫** (≈ $3.0). Alternative: 99,000₫ | **$9.99** (alternative $7.99 to undercut) | 79k is about the price of YouTube Premium VN and **cheaper than one hour of court rental**. Spotify VN is 65k₫ [S]. $9.99 sits between Spherely and Pickle Sensei ($7.99) and SwingVision Plus ($14.99) |
| Yearly | **599,000₫** (≈ 50k₫/month; 37% off). Alternative: 499,000₫ | **$59.99** (alternative $49.99) | Can be marketed as "under 50,000₫ a month". Matches Spherely's $59.99 |
| Trial | **7-day free trial on yearly only** (introductory offer). Monthly: optional "pay up front" intro, e.g. 29,000₫ for month 1 [U] | 7-day free trial on yearly | RevenueCat 2026: trials of 5–9 days convert at a median of about 37%, longer trials higher [S] ([link](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026.md)). Cap trial usage at about 5 analyses |
| Coach plan (later) | about 249k₫/month | $29.99/month | Benchmark: OnForm Coach at $29.99 |

**Commission:** the Small Business Program rate is **15%**, but you must **enrol**; it is not automatic. Eligibility: under $1M proceeds per year [V] ([Apple](https://developer.apple.com/app-store/small-business-program/)). Subscriptions also drop to 15% after a subscriber's first paid year, regardless of the program [S].

**VN tax (Apple, Aug 2025) [V] ([Apple news](https://developer.apple.com/news/?id=qs5bol0)):**
- Organisations based outside VN: VAT went from 5% to 10%.
- VN-based organisations: Apple **no longer remits** foreign contractor tax on sales; a 5% foreign contractor tax applies to Apple's commission.
- VN-based individuals: Apple withholds 2% PIT.

So the tax result depends on how the user registers (individual, VN company or foreign company). Get a tax adviser [U]. The model below assumes the VND price includes 10% VAT, which is conservative.

### 3.2 Estimated AI cost per analysis [U, for the backend researcher to refine]
Assumptions:
- About 14K input tokens: 4K cached system prompt and rubric, about 7K pose features, 4–6 key frames at reduced resolution (about 3K tokens).
- About 5K output tokens (3K JSON plus about 2K thinking).
- Prices from the claude-api skill, cached 2026-10-06. Exchange rate: 1 USD ≈ 26,000₫ (Vietcombank sell rate about 26,090 mid-Oct 2026 [S]).

| Model | $/MTok in/out | Cost per analysis | +15% retries and overhead |
|---|---|---|---|
| `claude-haiku-5-5` | 0.10 / 0.50 | ≈ $0.004 | ≈ $0.005 |
| `claude-sonnet-5-5` | 2 / 10 (cache read 0.20) | ≈ $0.07 | ≈ $0.08 |
| `claude-opus-5-5` | 4 / 20 (cache read 0.20) | ≈ $0.14 | ≈ $0.16 |

### 3.3 Unit economics (per subscriber per month, Sonnet at $0.08 per analysis)

| Plan | Price | Net of VAT | ×0.85 commission = proceeds/month | 8 analyses/month | **Margin** | Margin at heavy use (30/month) |
|---|---|---|---|---|---|---|
| VN monthly 79k₫ | $3.04 | $2.76 | **$2.35** | $0.64 | **$1.71 (73%)** | −$0.05 (loss) |
| VN monthly 99k₫ | $3.81 | $3.46 | $2.94 | $0.64 | $2.30 (78%) | +$0.54 |
| VN yearly 599k₫ | $23.0/yr | $20.9 | **$1.48** | $0.64 | **$0.84 (57%)** | −$0.92 |
| VN yearly 499k₫ | $19.2/yr | $17.4 | $1.24 | $0.64 | $0.60 (48%) | −$1.16 |
| US monthly $9.99 | $9.99 (US sales tax added on top) | n/a | **$8.49** | $0.64 | **$7.85 (92%)** | $6.09 |
| US yearly $59.99 | $5.00 | n/a | **$4.25** | $0.64 | **$3.61 (85%)** | $1.85 |

EU storefronts include VAT (about 20%), so proceeds there are about 15–20% lower than the US figures.

**Free-tier cost per 100 monthly active users (MAU), assuming 3% pay monthly:**

| Scenario | Paid margin | Free cost (97 users × 1 analysis/month) | Net per 100 MAU |
|---|---|---|---|
| VN, free tier on Sonnet | 3 × $1.71 = $5.13 | 97 × $0.08 = $7.76 | **−$2.63** ❌ |
| VN, free tier on Haiku | $5.13 | 97 × $0.005 = $0.49 | **+$4.64** ✅ |
| US, free tier on Sonnet | 3 × $7.85 = $23.55 | $7.76 | **+$15.79** ✅ |

The welcome analyses cost about $0.24 per new user on Sonnet. Treat that as acquisition cost, or use Sonnet only for the first analysis.

**Guardrails to build into the MVP:**
- A per-tier quota table in Postgres. Fair-use caps: VN monthly about 20/month, yearly about 15/month, US about 60/month [U].
- A configurable `model_by_tier` setting.
- Prompt caching on the system prompt and rubric.
- Downscaled key frames, about 768 px.
- Analyse only the user's locale, not both languages.
- Server-side idempotency so retries are not billed twice.

---

## 4. App Store Review compliance checklist

| # | Guideline | Requirement | What to build or do for this app | Grade |
|---|---|---|---|---|
| 1 | **3.1.1 IAP** | Digital subscriptions must use In-App Purchase, with a **Restore Purchases** button | StoreKit 2. Server-side verification via App Store Server API and Server Notifications V2 into a Supabase Edge Function (or RevenueCat; backend decision). **Coach or partner promo codes must be Apple Offer Codes**; backend-only unlock codes are a violation. Offer Codes: up to 1M redemptions per app per quarter; custom codes like `HLVMINH` are allowed [S] ([Apple](https://developer.apple.com/help/app-store-connect/manage-subscriptions/set-up-subscription-offer-codes)). SwiftUI `offerCodeRedemption` | [V] |
| 2 | **3.1.2 auto-renewable** | Must provide ongoing value. Before purchase, show subscription name, duration, price (and price per unit where relevant), auto-renew terms, and **working links to Terms of Use (EULA) and Privacy Policy**. **The billed amount must be the most prominent price**; trial and "≈50k₫/month" text must be smaller [S] ([forum](https://developer.apple.com/forums/thread/807082)) | Paywall component with VI/EN disclosure text. Privacy Policy URL in App Store Connect. EULA link in the description, or a custom EULA. `manageSubscriptionsSheet` | [S] |
| 3 | **5.1.2(i) third-party AI (Nov 2025)** | Disclose clearly and **get explicit permission before sharing personal data with third-party AI** [V] ([TechCrunch](https://techcrunch.com/2025/11/13/apples-new-app-review-guidelines-clamp-down-on-apps-sharing-personal-data-with-third-party-ai)). There are rejections on record [S] ([forum](https://developer.apple.com/forums/thread/816140)) | First-run and pre-upload consent screen (VI/EN) that names **Anthropic (Claude)**, lists what is sent (pose coordinates plus N face-blurred key frames, not the video), and states retention. Store a consent record with version and timestamp. Allow withdrawal in Settings | [V] |
| 4 | **5.1.1 privacy and permissions** | Privacy policy in the app and in metadata; collect only the minimum; purpose strings | Use **PHPickerViewController**, which needs no photo-library permission. `NSCameraUsageDescription` for in-app recording. Record **without audio** so no microphone prompt is needed (`NSMicrophoneUsageDescription` only if audio is added). `NSPhotoLibraryAddUsageDescription` only if saving share cards. Localise everything in `InfoPlist.xcstrings` (vi, en). Never upload video by default | [V] |
| 5 | **5.1.1(v) account deletion** | Deletion must start in the app. Deactivation alone is not enough. No email or phone-call flows. **Revoke Sign in with Apple tokens via REST** [V] ([Apple](https://developer.apple.com/support/offering-account-deletion-in-your-app)) | Delete-account Edge Function: auth user, rows, storage objects, SIWA revoke (keep the refresh token server-side at sign-in, because the authorization code expires after 10 minutes [S]). Tell users that billing continues until they cancel the Apple subscription, and link to manage subscriptions | [V] |
| 6 | **4.8 login services** | If Google sign-in is offered, an equivalent privacy-preserving option is required. **Sign in with Apple meets it** [S] | Already planned. Follow the HIG button style | [S] |
| 7 | **App Privacy labels** | Declare collected data | Likely entries: Contact Info (email, name); Identifiers (user ID); **User Content: Photos or Videos** (key frames) and **Other User Content** (pose data); Purchases; Diagnostics (crash data, if a crash SDK is used); Usage Data (only if analytics). **Fitness** is a judgment call; declaring it is the conservative choice [U]. All "linked to user", not used for tracking, so no ATT prompt | [U] |
| 8 | **Privacy manifest (`PrivacyInfo.xcprivacy`)** | Required-reason APIs and collected data types | `NSPrivacyTracking=false`. Reasons: UserDefaults `CA92.1`; file timestamps `C617.1` (or `3B52.1` for user-picked files); system boot time `35F9.1` (only if you call `systemUptime` or `mach_absolute_time` directly); disk space `E174.1` or `85F4.1` if you check free space before recording [S] ([MS Learn](https://learn.microsoft.com/dotnet/maui/ios/privacy-manifest)). Third-party SDKs (GoogleSignIn, supabase-swift, RevenueCat) must ship their own manifests and signatures; confirm the versions [U] | [S] |
| 9 | **1.4.1 / health claims** | Medical or diagnostic claims get extra scrutiny | Present the app as **sports technique education**. No "injury prevention" or diagnosis claims. Add the in-app line "Not medical advice; stop if pain". Skip HealthKit in the MVP | [V] |
| 10 | **Filming other people** | 5.1.1 data minimisation; VN Civil Code Art. 32 image rights (consent to *use* a person's image; public sports events are an exception) [S] ([LawNet](https://lawnet.vn/thong-tin-phap-luat/en/tu-van-luat/is-the-use-of-other-people-s-images-without-permission-subject-to-compensation-in-vietnam-102840.html)) | Upload checkbox: "Tôi có sự đồng ý của người trong video / I have consent of the person filmed". Matching clause in the Terms. On-device face blur (Vision face detection) before key-frame upload. Delete key frames after N days | [S] |
| 11 | **Minors and age rating** | New tiers 4+/9+/13+/16+/18+; the age-rating questionnaire update was due **31 Jan 2026** [S]. Texas App Store Accountability Act in effect from 1 Jan 2026 [S] ([link](https://trysonar.app/blog/app-store-age-rating)) | No public UGC or chat in the MVP, so a low rating is likely. Do **not** join the Kids category. Terms: 13+; under 16 needs a parent or guardian (VN, see §5). Parents may analyse their own child's video with a guardian attestation | [S] |
| 12 | **1.2 UGC (future)** | A community feed needs filtering, reporting, blocking and contact info | Keep the MVP free of public UGC. Share cards go out through the system share sheet only | [V] |
| 13 | **2.1 completeness** | The reviewer must be able to test every feature | Provide a **demo account** and a **bundled sample clip per sport** ("Try a sample analysis"). Make the paywall work in sandbox | [V] |
| 14 | Export compliance | — | Set `ITSAppUsesNonExemptEncryption=NO` (HTTPS only) | [V] |
| 15 | US external purchase links | The Ninth Circuit (Dec 2025) allows Apple a "cost-based" commission; the case is now before the Supreme Court [S] ([link](https://thenextweb.com/news/supreme-court-apple-epic-contempt-app-store-commission)) | **Not for the MVP.** Use IAP only | [S] |

---

## 5. Vietnam-specific requirements

### 5.1 Personal data and other law

| Item | Status | What it means for the app |
|---|---|---|
| **PDPL, Law 91/2025/QH15** | Passed 26 Jun 2025; **in force 1 Jan 2026** [V] | Explicit, purpose-specific consent, never pre-ticked; VN-language privacy notice; rights to access, delete and withdraw. Fines up to **5% of the previous year's revenue (or VND 3bn, whichever is higher)** for cross-border transfer breaches [S] ([Tilleke](https://tilleke.com/insights/vietnams-new-personal-data-protection-law-a-closer-look), [LuatVietnam](https://english.luatvietnam.vn/legal-updates/the-latest-law-on-personal-data-protection-and-the-guiding-documents-892-106778-article.html)) |
| **Decree 356/2025/ND-CP** | Issued 31 Dec 2025; in force 1 Jan 2026; **replaces Decree 13/2023** [V] | Template forms for the impact assessment (DPIA) and the cross-border transfer assessment (CTIA). MPS reviews within about 15 days; incomplete dossiers have about 30 days to fix [S] ([Vietnam Briefing](https://www.vietnam-briefing.com/news/vietnam-personal-data-protection-regulation-decree-356.html), [PwC](https://www.pwc.com/vn/en/publications/2026/20260128-new-rules-personal-data-protection.pdf)) |
| **Small business and startup relief** | 5-year grace period on the DPIA and Data Protection Officer requirements. **Does not apply** to sensitive data, large data volumes or processing services. Unclear whether it covers the CTIA [S] | Prepare a **CTIA dossier** for the Anthropic (US) and Supabase transfers. Keep processing out of "sensitive" categories: blur faces, store pose-derived features rather than raw images. Whether pose counts as biometric data is unresolved [U] |
| **Children's data** | Sensitive category. The parental consent age is cited as under 16 in one source [U] ([Clym](https://www.clym.io/regulations/personal-data-protection-law-pdpl-vietnam)) | Age gate at sign-up; guardian consent flow, or block under-16 accounts in the MVP |
| **Decree 53/2022 data localisation** | Art. 26.2 says domestic enterprises must store certain user data in VN. It is ambiguous whether a local copy is enough [S] ([Tilleke](https://www.tilleke.com/insights/what-do-vietnams-new-data-localization-requirements-mean-for-domestic-enterprises/5/)) | **Legal question:** if operating through a VN company, Supabase Singapore alone may not comply. Mitigations: minimal data, or a VN copy later (Viettel, FPT or VNG cloud) [U] |
| **E-commerce Law 122/2025/QH15** | In force 1 Jul 2026, with Decree 248/2026 [S] ([TVPL](https://thuvienphapluat.vn/van-ban/Thuong-mai/Lenh-cong-bo-Luat-Thuong-mai-dien-tu-2025-691395.aspx)) | Unclear whether a subscription app selling through the App Store must notify the Ministry of Industry and Trade [U]. Ask counsel |
| Anthropic data handling | Commercial API: about 30-day default retention. Zero data retention is available only on approval [S] ([Anthropic](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)) | State the retention period in the consent screen and privacy policy |

### 5.2 Localisation, payments and tax
- **Language:** use String Catalogs (`.xcstrings`) for VI and EN, and localise the App Store metadata, screenshots and Info.plist purpose strings. Coaching output should be generated in the user's locale.
- **Use Vietnamese sport terms**, not literal translations, for example "đập cầu", "bỏ nhỏ", "phông cầu", "dink", "bếp (kitchen)". A coach should review the glossary [U].
- **Payments:** the App Store handles VND billing (cards, carrier billing, and in some markets MoMo wallet [U]). Set VN prices manually per storefront. Apple's Sept 2025 VN price adjustments did **not** change auto-renewable subscription prices [S].

### 5.3 Marketing channels (VN)
- **Facebook groups.** "Pickleball Saigon" has about 40k members [S] ([link](https://vietcetera.com/en/why-does-vietnam-love-pickleball)). Also city and club badminton groups. Post before/after technique clips.
- **TikTok:** short "AI chấm kỹ thuật" videos and creator coaches. **Zalo:** clubs organise sessions in Zalo groups; use a Zalo Official Account for support and share cards. [U]
- **Courts:** QR posters at courts ("Quay 1 cú đánh – nhận phân tích AI miễn phí"); bundles through ALOBO, D-Joy and Champick.
- **Tournaments and brands:** D-Joy Tour, PPA Asia, Pickleball World Cup Da Nang 2026; equipment shops and brands on Shopee or TikTok Shop bundling a 1-month Offer Code.
- **Scam caution:** police warn about fake pickleball federation pages [S] ([Znews](https://znews.vn/thu-doan-gia-danh-lien-doan-pickleball-viet-nam-post1515301.html)). Use a verified brand and an official domain.

### 5.4 Partnership ideas
1. **Coach programme:** each coach gets an Offer Code (for example, the first month free), sends students a pre-session assignment ("film your serve"), and later gets a coach dashboard.
2. **Court partners:** a free analysis day at the court, with co-branded share cards.
3. **Booking apps:** deep link "Analyse your session" after a booking.
4. **Beginner clinics:** RPO/COEBRA programmes and university tournaments (e.g. a national student pickleball event planned for 2026 [S]).

---

## 6. Growth and retention features

| Feature | MVP | v1.1 | Later | Why |
|---|---|---|---|---|
| Single-stroke analysis: scores, strengths, weaknesses, fixes, VI/EN | ✅ | | | Core value |
| **Drill plan per weakness** (3–5 drills, reps, video or GIF placeholders) | ✅ | Calendar and reminders | | Turns a one-off analysis into a habit; supports "ongoing value" under 3.1.2 |
| **Progress tracking**: history, per-stroke score trend | ✅ (basic list and chart) | Streaks, weekly summary | | Main subscription retention driver |
| Capture guidance (angle, fps, framing overlay) | ✅ | | | Better input means better output and fewer retries (lower cost) |
| Sample or demo analysis | ✅ | | | Needed for App Review and onboarding |
| **Share card** (score plus tip, VI/EN, app link) | ✅ (simple image) | Templates, TikTok format | | Organic growth in FB, Zalo and TikTok |
| Pose skeleton overlay on the user's clip (on device) | ✅ if cheap | | | Visual "wow" with no extra AI cost |
| Compare with a pro or reference pose (side-by-side, DTW-aligned) | | ✅ | | Strong differentiator; needs licensed or self-filmed reference clips |
| Referral (give/get free analyses) | | ✅ | | Cheap acquisition |
| Coach sharing (send an analysis to a coach, coach comments) | | ✅ | Coach marketplace | Build B2B2C later |
| Skill level estimate (Vietnamese-style "trình") | | ✅ with care | | Popular locally (Chấm Trình AI); avoid DUPR trademark claims |
| Community feed, challenges | | | ✅ | Needs 1.2 moderation, and possibly a VN social-network notification [U] |
| Android | | | ✅ | Required for mass-market VN badminton |
| Tennis or padel expansion | | | ✅ | Same pipeline |

---

## 7. Requirements to put into the codebase plan
- **Paywall view** meeting the 3.1.2 rules (billed amount most prominent, EULA and Privacy links, restore button, manage-subscriptions link, offer-code redemption), with per-tier quotas enforced server-side.
- **AI consent screen** naming Anthropic, with a stored consent version, plus the **filming-others consent checkbox**. Also an age gate (13+, guardian flow under 16) and a "not medical advice" note.
- **On-device face blur** before uploading key frames. Never upload video by default. Key-frame retention TTL (for example 30 days), configurable.
- **Delete-account Edge Function**, including Sign in with Apple token revocation. Privacy manifest. Localised Info.plist strings. `ITSAppUsesNonExemptEncryption=NO`.
- **Demo mode with bundled sample clips** for review and onboarding.
- **Configurable model routing per tier** (Haiku for free, Sonnet for paid). Prompt caching. Per-user monthly caps. Cost logging per analysis.
- Hosted **VI/EN Terms of Use and Privacy Policy** (static pages). App Store Connect metadata in both languages.
- **Operational:** enrol in the Small Business Program; set VN storefront prices manually; prepare the CTIA dossier and a legal review (VN counsel); decide the legal entity (VN individual, VN company or foreign company) because it changes tax and data-localisation obligations.

## 8. Open questions and unverified items
- Exact App Store VND price points (check the App Store Connect picker).
- Current PB Vision and Pickle Sensei pricing.
- Pricing and developer of Chấm Trình AI.
- Whether pose data counts as "biometric" under the PDPL.
- Whether the startup grace period covers the CTIA.
- Decree 53 localisation for a VN-registered entity.
- Whether the E-commerce Law requires Ministry of Industry and Trade notification.
- Exact iOS share in VN.
- Whether the third-party SDKs ship valid privacy manifests.
