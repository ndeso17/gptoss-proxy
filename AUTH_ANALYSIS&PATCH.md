# Hasil Analisis Autentikasi GPT-OSS & Perbaikan Proxy

## 1. Temuan Utama
Setelah melakukan audit terhadap Cloudflare Worker (`worker.js`) dan mengamati traffic langsung terhadap `api.gpt-oss.com`, ditemukan bahwa GPT-OSS baru-baru ini memperketat keamanan dan mewajibkan autentikasi bagi pengguna, terutama untuk membuat thread chat baru dan membalas pesan.

### Perubahan API:
1. **Widget Login via SSE**: Ketika worker mencoba mengirim chat (`POST /chatkit`) tanpa cookie sesi yang valid, GPT-OSS tidak mengembalikan status HTTP `401 Unauthorized` di level HTTP header, melainkan mengembalikan response `HTTP 200 OK` yang di dalamnya berisi event Server-Sent Events (SSE). Event tersebut merender **Widget Card** yang isinya meminta pengguna login menggunakan Hugging Face:
   ```json
   {
     "type": "widget",
     "widget": {
       "type": "Card",
       "children": [
         { "value": "Sign in to continue" },
         { "value": "Sign in with Hugging Face to start chatting with gpt-oss" }
       ]
     }
   }
   ```
2. **Bug di Worker Lama**: Implementasi `worker.js` yang lama tidak menyadari bahwa GPT-OSS membalas dengan widget Card. Worker lama hanya menyaring `text_delta` (yang mana nilainya kosong jika belum login) dan menganggap proses selesai, lalu mengembalikan string kosong kepada client API (LibreChat/OpenWebUI dll).
3. **Persyaratan Cookie HF**: Autentikasi GPT-OSS sepenuhnya mengandalkan Cookie HuggingFace. Worker harus meneruskan cookie tersebut di header `Cookie` saat melakukan fetch ke hulu (upstream).

## 2. Mekanisme Autentikasi yang Diperbaiki

Worker kini telah di-patch menggunakan arsitektur manajemen autentikasi Multi-Layered:

1. **Prioritas Resolusi Cookie**:
   Worker akan mencoba mencari Cookie dengan urutan prioritas:
   - Header request saat ini: `X-Gptoss-Cookie`
   - Header `Authorization: Bearer <cookie_string>`
   - Environment Variable (Cloudflare Secret): `HF_COOKIE`
   - Environment Variable (Cloudflare Secret): `GPTOSS_AUTH_COOKIE`
   - Cloudflare KV Binding (Stateful Session): Namespace `AUTH_KV`

2. **Deteksi Proaktif (Widget Interceptor)**:
   Baik pada mode stream (SSE stream transform) maupun non-stream (SSE Aggregator), worker akan memeriksa isi event JSON. Jika ditemukan widget "Sign in with Hugging Face", worker akan langsung membatalkan stream ke client dan menerbitkan pesan error OpenAI-compatible standard (status 401). Selain auth, ia juga akan menangkap captcha, invalid session, dan rate limit.

## 3. Cara Konfigurasi & Mengganti Akun

Autentikasi ke GPT-OSS membutuhkan **dua variabel cookie utama**, yakni `user_id` dan `session`. Karena diproteksi dengan *HttpOnly*, Anda tidak bisa mencopas lewat `document.cookie` di Console.

**Langkah Mengambil Cookie dari Browser:**
1. Login ke `https://gpt-oss.com`
2. Buka **F12 / DevTools** -> Pilih tab **Application** (atau Storage di Firefox).
3. Di panel kiri, buka **Cookies** -> pilih `https://gpt-oss.com`.
4. Salin nilai dari dua baris ini:
   - `user_id` (misal: `fae7d08b-1d37...`)
   - `session` (misal: `eyJoZl9hY2Nlc3...`)
5. Gabungkan menjadi satu string dengan format:
   ```text
   user_id=NILAI_USER_ID; session=NILAI_SESSION
   ```

Anda memiliki 2 cara untuk memasukkan string gabungan tersebut:

### Cara 1: Menggunakan Cloudflare Secrets (Rekomendasi)
Gunakan perintah `wrangler` untuk menanamkan cookie gabungan Anda secara permanen.

```bash
wrangler secret put HF_COOKIE
```
Lalu *paste* seluruh string gabungan Anda. (Catatan: Worker kini bisa membaca `HF_COOKIE` maupun `GPTOSS_AUTH_COOKIE`).

### Cara 2: Menggunakan Cloudflare KV dan API Auth (Untuk Rotasi Akun)
Anda bisa membuat KV Namespace di Cloudflare dan menambahkannya ke `wrangler.toml` Anda dengan binding name `AUTH_KV`.

```toml
[[kv_namespaces]]
binding = "AUTH_KV"
id = "<id_namespace_anda>"
```
Lalu, Anda dapat menggunakan endpoint API yang telah kami buat untuk mengubah/mengecek akun tanpa harus deploy ulang:

- **Cek Status**: `GET /auth/status`
- **Login/Ganti Akun**: `POST /auth/login` dengan JSON `{"cookie": "user_id=...; session=..."}`
- **Logout/Hapus Akun**: `POST /auth/logout`

## 4. Kompatibilitas Router (9router / LiteLLM)
Perbaikan terbaru memastikan dukungan 100% pada OpenAI Drop-In Replacement yang ketat (biasanya digunakan di `9router`, `LiteLLM`, atau `Portkey`):
- **Usage Reporting**: Mengirim token counts secara akurat, mencegah null-crash.
- **Stream Options**: Mendukung fitur `stream_options.include_usage: true` dengan chunk meta terpisah sebelum `[DONE]`.
- **First Delta Standard**: Chunk pertama dari stream memastikan bentuk objek `delta: { role: "assistant", content: "" }`.
- **Standard Error Models**: `{"error": {"type": "api_error", "message": "..."}}`.
- **Clean System Fingerprint**: Membersihkan output reasoning internal model dari metadata payload, menyisakan string fingerprint yang bersih.
