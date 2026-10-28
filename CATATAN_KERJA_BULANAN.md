# Catatan Kerja Bulanan - SPM API

## Bulan: Oktober 2026

---

### Tanggal: 28 Oktober 2026
**Topik:** Perbaikan Kendala Timeout Modul IoT SPM (Unit HD78247), Optimalisasi Connection Pool MySQL, Universal Body Parser, dan Penyelarasan Response Endpoint `/ppa`.

---

### 1. Deskripsi Permasalahan
- Modul IoT pada unit alat berat **HD78247** di site **PPA (Site 37)** mengalami kegagalan saat mengirimkan log data tertunda (*pending file*) melalui program `Apps/kirim_data_log` ke endpoint API:
  `https://iot.cts-chitraparatama.co.id/ppa`
- Pesan error pada terminal unit:
  ```text
  URL API : https://iot.cts-chitraparatama.co.id/ppa
  PUSH HTTP POST : 120 detik
  /home/user/Apps/log/HD78247/pendingfile.txt
  curl_easy_perform() failed: Timeout was reached
  POST Index 0 Gagal Terkirim
  Program keluar karena tidak ada balasan API
  ```
- Modul keluar secara otomatis dan pengiriman terhenti karena tidak menerima balasan API dalam batas waktu 120 detik.

---

### 2. Analisis & Akar Masalah (Root Cause Analysis)

1. **Saturasi Connection Pool Database MySQL**:
   - Endpoint `/ppa` sebelumnya menggunakan konfigurasi `connectionLimit: 10` tanpa *socket timeout*.
   - Setiap baris data pending yang dikirim mengeksekusi query berulang ke remote MySQL `103.229.73.124`:
     - Query baca standar tekanan ban ke tabel `site` di database `ctsmngr`.
     - Query `SELECT *` (50 kolom) pada tabel `tpms` (berisi lebih dari 61 juta baris) untuk mencari data terakhir unit.
     - Query pengecekan auto-tapping ban 1 sampai 6.
   - Saat puluhan unit online secara simultan bersamaan dengan pengiriman data pending berurutan, 10 koneksi MySQL habis terpakai sehingga antrian koneksi (`queueLimit: 0`) menumpuk di memori Express dan melampaui batas waktu 120 detik client.

2. **Parsing Header Content-Type**:
   - `express.json()` bawaan hanya memproses request dengan header eksplisit `Content-Type: application/json`.
   - Modul IoT atau program libcurl sering kali mengirimkan data tanpa header atau dengan `text/plain`, menyebabkan `req.body` kosong `{}` dan ditolak dengan status 400.

3. **Format Response Text & Handling Duplikasi (Race Condition)**:
   - Baris pertama di `pendingfile.txt` (key `HD7824710280840`) sudah pernah tersimpan di database.
   - Format teks response sebelumnya berbeda dengan default bawaan PHP lama (`gettpmsdata.php`), dan jika terjadi *race condition* saat insert duplikat, server melempar uncaught error HTTP 500 (`ER_DUP_ENTRY`).

---

### 3. Rincian Perbaikan yang Diterapkan di `index.js`

1. **Optimalisasi Pool Koneksi MySQL (Multi-Pool)**:
   - Menaikkan kapasitas pool dari 10 menjadi `connectionLimit: 25`.
   - Menambahkan parameter `connectTimeout: 10000`, `enableKeepAlive: true`, dan `keepAliveInitialDelay: 10000` pada seluruh pool (`poolCts`, `poolSpm`, `poolCts3`) untuk mencegah koneksi gantung (*stale/hung connection*).

2. **In-Memory Cache Standar Tekanan Site (`getSitePressures`)**:
   - Membuat fungsi caching di memori (TTL 1 jam) untuk konfigurasi standar tekanan `front_press` dan `rear_press` per `id_site`. Request realtime tidak lagi melakukan query remote berulang ke tabel `site`.

3. **Optimalisasi Query `data_last`**:
   - Mengubah query `SELECT * FROM tpms` (50 kolom) menjadi hanya mengambil kolom status ban yang dibutuhkan (`timestamp, pressure_unit, pressure_1..6, press_stat_1..6`).

4. **Universal Body Parser Middleware**:
   - Menambahkan middleware otomatis sebelum Express parser:
     - Jika request tidak memiliki header `content-type`, otomatis diasumsikan `application/json`.
     - Mendukung tipe `['application/json', 'text/*', '*/*']` serta decoding otomatis jika `req.body` diterima sebagai string mentah.

5. **Penanganan Error Duplikat (HTTP 500 $\rightarrow$ HTTP 200)**:
   - Menambahkan penanganan `error.code === 'ER_DUP_ENTRY'` pada blok `try-catch` insert database di endpoint `/ppa` dan `/ck` agar jika terjadi duplikasi key, server tetap merespons aman dengan HTTP 200:
     `Data dengan Key ${key} sudah ada. Insert dibatalkan agar tidak ganda.`

6. **Penyelarasan Teks Response dengan Standar PHP**:
   - Berhasil insert: `Data berhasil disimpan. Key: ${key}` (HTTP 200).
   - Duplikat: `Data dengan Key ${key} sudah ada. Insert dibatalkan agar tidak ganda.` (HTTP 200).
   - Devicename kosong: `OK` (HTTP 200).

7. **Implementasi Live Monitoring Request (`api_debug_log`)**:
   - Menambahkan middleware non-blocking untuk mencatat setiap request yang masuk ke tabel `api_debug_log` (merekam IP client, method HTTP, path, preview body, dan headers).

---

### 4. Hasil Verifikasi & Status Akhir

- **Status Server**: Berjalan stabil di platform Dokploy, melayani ribuan request per jam dari berbagai unit site PPA dan CK dengan rata-rata waktu respon sub-detik (**< 300 ms**).
- **Status Unit HD78247**:
  - Modul unit telah berhasil terhubung dan secara kontinu mengirimkan data terbaru setiap 2 menit ke `https://iot.cts-chitraparatama.co.id/ppa`.
  - Data masuk secara realtime dan sukses ter-insert ke database `k6218892_spm` (tabel `tpms`).
