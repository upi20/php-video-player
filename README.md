# PHP Video Player

Pemutar video pribadi untuk folder video lokal: taruh file video di satu folder, jalankan satu perintah Docker, lalu tonton dari browser dengan tampilan ala YouTube.

Video di-*stream* langsung oleh Apache (HTTP Range), jadi bisa loncat ke menit mana pun tanpa menunggu file selesai diunduh. Thumbnail, peta kekerasan suara, dan pratinjau saat hover dibuat otomatis oleh ffmpeg, lalu disimpan di cache.

## Fitur

**Beranda**
- Grid video seperti YouTube: 1 kolom di HP, sampai 5 kolom di layar lebar
- Thumbnail, durasi, resolusi, ukuran, dan kapan file ditambahkan
- Garis progress di thumbnail untuk video yang belum selesai ditonton
- Urutkan: terbaru, terlama, nama, ukuran, terpanjang
- Pencarian langsung dengan highlight kata yang cocok

**Halaman tonton**
- Controls custom dengan **peta kekerasan suara** di bar seek. Bagian yang suaranya keras diberi warna oranye, jadi langsung kelihatan detik mana yang ramai.
- **Pratinjau frame saat hover** di bar seek, seperti di YouTube
- **Mode bioskop**: video selebar jendela, daftar putar pindah ke bawah
- Melanjutkan dari posisi terakhir ditonton
- Autoplay video berikutnya dengan hitung mundur yang bisa dibatalkan
- Ganti video tanpa reload halaman, tombol Back browser tetap berfungsi
- Kecepatan putar, volume (diingat), layar penuh, dan shortcut keyboard
- Mobile-first: di HP player menempel di atas saat daftar putar di-scroll

## Kebutuhan

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (atau Docker Engine + Compose)
- Browser modern: Chrome, Brave, Edge, Firefox, atau Safari

PHP dan ffmpeg tidak perlu dipasang di komputer, karena keduanya sudah ada di dalam image Docker.

## Instalasi

### Folder baru

```bash
git clone https://github.com/upi20/php-video-player.git ~/Videos/player
cd ~/Videos/player
# salin atau pindahkan file video ke folder ini
docker compose up -d
```

Buka **http://localhost:8015**.

### Folder video yang sudah ada

`git clone` tidak bisa ke folder yang sudah berisi file. Untuk memasang di folder yang sudah berisi video:

```bash
cd ~/folder-video-anda
git init
git remote add origin https://github.com/upi20/php-video-player.git
git pull origin main
docker compose up -d
```

`.gitignore` di repo ini memakai pola *whitelist*: semua file diabaikan kecuali kode aplikasi. Jadi video Anda dan folder `.cache` tidak akan pernah ikut ter-commit.

### Perintah sehari-hari

```bash
docker compose up -d        # nyalakan
docker compose down         # matikan
docker compose logs -f      # lihat log
docker compose up -d --build   # bangun ulang image setelah mengubah .docker/Dockerfile
```

Container otomatis menyala lagi setiap Docker dijalankan (`restart: unless-stopped`). Video baru langsung muncul setelah halaman di-refresh.

## Shortcut keyboard

| Tombol | Aksi |
|---|---|
| <kbd>K</kbd> / <kbd>Spasi</kbd> | Putar / jeda |
| <kbd>J</kbd> / <kbd>L</kbd> | Mundur / maju 10 detik |
| <kbd>←</kbd> / <kbd>→</kbd> | Mundur / maju 5 detik |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Volume naik / turun |
| <kbd>M</kbd> | Bisu |
| <kbd>F</kbd> | Layar penuh |
| <kbd>T</kbd> | Mode bioskop |
| <kbd>N</kbd> / <kbd>P</kbd> | Video berikutnya / sebelumnya |
| <kbd>/</kbd> | Fokus ke pencarian |

## Cara kerja

```
browser ──GET /nama.mp4 (Range)──────▶ Apache: stream file langsung, bisa di-seek
        ──GET / atau /?v=nama.mp4────▶ index.php → halaman beranda / tonton
        ──GET /?api=...&v=nama.mp4───▶ index.php → ffmpeg / ffprobe → .cache/
```

Semua yang dibuat ffmpeg hanya dibuat **sekali per video**, lalu disimpan di `.cache/` dengan nama `<kunci>.<jenis>`. Kuncinya dihitung dari nama, ukuran, dan waktu ubah file, jadi file yang diganti otomatis dianalisis ulang. Kalau beberapa request datang bersamaan, ffmpeg tetap hanya berjalan sekali (dikunci dengan `flock`).

| Hasil | Dibuat dengan | Waktu (video 1 GB) |
|---|---|---|
| Durasi dan resolusi | `ffprobe` | < 0,1 detik |
| Thumbnail (480×270) | `ffmpeg -ss` di 20% durasi | ~0,1 detik |
| Peta suara | filter `ebur128` (loudness EBU R128), 1 nilai per 0,5 detik | ~1–2 detik |
| Pratinjau hover | hanya *keyframe* (`-skip_frame nokey`), disusun 8×8 per lembar JPEG | ~1–7 detik |

Saat sebuah video diputar, peta suara dan pratinjau untuk video berikutnya di daftar ikut disiapkan di latar belakang.

### API

Semua endpoint menerima `v=<nama file>` dan `k=<kunci cache>`. Karena kunci berubah setiap kali file berubah, respons boleh di-cache selamanya oleh browser.

| Endpoint | Hasil |
|---|---|
| `?api=thumb` | JPEG thumbnail |
| `?api=loudness` | `{"step":0.5,"values":[LUFS, ...]}` |
| `?api=storyboard` | `{"interval","cols","rows","width","height","sheets","frames"}` |
| `?api=storyboard&sheet=N` | JPEG lembar pratinjau ke-N (mulai dari 1) |

## Struktur proyek

```
index.php                   router: beranda, halaman tonton, atau API
docker-compose.yml
.docker/
  Dockerfile                php:8.3-apache + ffmpeg
  apache.conf               blokir file privat, matikan daftar isi folder
.app/
  lib/                      PHP: bootstrap, process, cache, videos, loudness,
                            storyboard, thumbnail, api, view
  views/                    layout, home, watch, partials/(header, player)
  assets/
    css/                    base, home, watch (mobile-first)
    js/                     util, home, watch, player, seekbar (ES modules)
.cache/                     dibuat otomatis, tidak di-commit
```

Tidak ada build step, framework, atau dependensi npm/Composer.

## Konfigurasi

| Yang diubah | Di mana |
|---|---|
| Port, atau buka akses dari jaringan lokal | `ports` di `docker-compose.yml` |
| Ekstensi file yang dianggap video | `VIDEO_EXTS` di `.app/lib/bootstrap.php` |
| Ambang "suara keras" (default 20% teratas) | `LOUD` di `.app/assets/js/seekbar.js` |
| Ukuran dan kerapatan pratinjau hover | konstanta `SB_*` di `.app/lib/storyboard.php` |
| Ukuran thumbnail | `THUMB_W`, `THUMB_H` di `.app/lib/thumbnail.php` |
| Resolusi peta suara | `LOUDNESS_STEP` di `.app/lib/loudness.php` |

Mengubah ukuran thumbnail atau pratinjau tidak memengaruhi cache yang sudah ada. Untuk membuat ulang semuanya, hapus isi `.cache/`.

**Akses dari HP di WiFi yang sama:** ubah `"127.0.0.1:8015:80"` menjadi `"8015:80"`, jalankan `docker compose up -d`, lalu buka `http://<IP-komputer>:8015`. Perlu diingat, aplikasi ini tidak punya login, jadi siapa pun di jaringan itu bisa membukanya.

## Keamanan

- Folder video di-mount **read-only**. Aplikasi tidak bisa mengubah atau menghapus video. Satu-satunya folder yang bisa ditulis adalah `.cache/`.
- Secara default port hanya terbuka untuk `127.0.0.1`, jadi tidak bisa diakses dari perangkat lain.
- Apache hanya menyajikan `index.php`, `.app/assets/`, dan file video. `.app/lib`, `.app/views`, `.cache`, `.docker`, `.git`, file tersembunyi, serta file konfigurasi ditolak (403).
- Nama file dari URL divalidasi: harus berupa file video di folder ini, tanpa path, dan bukan file tersembunyi.
- ffmpeg dijalankan tanpa shell (`proc_open` dengan array argumen), jadi nama file yang aneh tidak bisa menyisipkan perintah.

## Batasan

- **Format dan codec mengikuti browser.** MP4 (H.264/AAC) dan WebM aman di semua browser. MKV, atau video HEVC/H.265, mungkin tidak bisa diputar di Chrome atau Brave. Pemutar akan menampilkan pesan kalau itu terjadi.
- Saat pertama kali dibuka, beranda menjalankan `ffprobe` sekali untuk setiap video. Untuk ratusan video, pemuatan pertama bisa makan beberapa detik. Setelah itu langsung dari cache.
- Pratinjau hover memakai keyframe terdekat dalam jarak beberapa detik, bukan frame yang persis di detik yang ditunjuk. Ini sengaja, supaya pembuatannya ringan.
- Posisi tontonan, volume, dan pengaturan lain disimpan di `localStorage` browser, jadi tidak ikut pindah ke browser atau perangkat lain.

## Troubleshooting

| Masalah | Solusi |
|---|---|
| `failed to connect to the docker API` | Docker Desktop belum berjalan. Buka Docker Desktop, tunggu sampai siap, lalu ulangi. |
| `port is already allocated` | Port 8015 sudah dipakai aplikasi lain. Ganti port di `docker-compose.yml`. |
| Video tidak muncul di daftar | Pastikan ekstensinya termasuk `VIDEO_EXTS` dan nama filenya tidak diawali titik. |
| "Video ini tidak bisa diputar" | Codec tidak didukung browser. Konversi dengan `ffmpeg -i input.mkv -c:v libx264 -c:a aac output.mp4`. |
| Thumbnail atau peta suara tidak muncul | Lihat `docker compose logs`, lalu hapus file cache video itu di `.cache/` supaya dibuat ulang. |
