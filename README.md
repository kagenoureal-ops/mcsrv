# MC Runtime

Node.js CLI runtime/process manager untuk menjalankan Minecraft Vanilla Java Edition dan, secara opsional, Bedrock Dedicated Server pada Linux Debian/Ubuntu.

Runtime ini menggunakan `child_process.spawn()` untuk proses server dan tidak membutuhkan dependency NPM eksternal.

## Requirements

- Linux Debian/Ubuntu compatible
- Node.js 18+
- Java yang sesuai dengan versi Minecraft yang digunakan
- Internet saat pertama kali membutuhkan `server.jar`
- EULA Minecraft harus diterima secara manual

Contoh environment:

```text
Node.js
OpenJDK 21.0.12.1
Debian 13 / Trixie
```

Cek:

```bash
node -v
java -version
```

## Install

Masuk ke directory project:

```bash
cd mc-runtime
```

Tidak perlu:

```bash
npm install
```

Karena runtime hanya menggunakan modul bawaan Node.js.

Jalankan:

```bash
npm start
```

## First Run / EULA

Pada first run, runtime membuat:

```text
servers/java/<server-id>/eula.txt
```

Isinya:

```text
eula=false
```

Runtime akan berhenti dan memberi tahu bahwa EULA belum diterima.

Edit file tersebut:

```bash
nano servers/java/survival-1218/eula.txt
```

Ubah:

```text
eula=false
```

menjadi:

```text
eula=true
```

Simpan, kemudian jalankan lagi:

```bash
npm start
```

Runtime tidak pernah otomatis menyetujui EULA.

## Config

Default `config.json`:

```json
{
  "host": "0.0.0.0",
  "servers": [
    {
      "id": "survival-1218",
      "platform": "java",
      "version": "1.21.8",
      "port": 25565,
      "memory": "2G"
    }
  ],
  "bedrock": {
    "enabled": false,
    "port": 19132,
    "serverDir": "./servers/bedrock",
    "binary": "./servers/bedrock/bedrock_server"
  }
}
```

### host

Default:

```text
0.0.0.0
```

Nilai ini digunakan sebagai konfigurasi runtime/network intent. Java `server.properties` sengaja memakai:

```text
server-ip=
```

agar Minecraft bind pada semua interface.

### Java server

Setiap object di `servers` adalah satu instance Minecraft Java.

Contoh:

```json
{
  "id": "survival-1218",
  "platform": "java",
  "version": "1.21.8",
  "port": 25565,
  "memory": "2G"
}
```

#### id

Nama unik instance.

Gunakan hanya:

```text
A-Z a-z 0-9 _ -
```

#### version

ID versi Minecraft Java yang tersedia di Mojang version manifest.

Runtime menggunakan:

```text
https://piston-meta.mojang.com/mc/game/version_manifest_v2.json
```

Runtime kemudian mengambil metadata versi dan URL `downloads.server.url` dari Mojang.

Tidak menggunakan website mirror pihak ketiga.

#### port

Port TCP Java.

Contoh:

```json
"port": 25565
```

#### memory

Contoh:

```json
"memory": "2G"
```

akan menjadi:

```text
-Xms2G
-Xmx2G
```

Contoh:

```json
"memory": "4G"
```

menjadi:

```text
-Xms4G
-Xmx4G
```

Format yang didukung:

```text
1024M
2G
4G
```

## server.properties

Jika belum ada, runtime membuatnya dengan minimal:

```properties
server-port=25565
server-ip=
motd=Node.js Minecraft Server
online-mode=true
view-distance=10
simulation-distance=10
```

`server-port` mengikuti `port` di `config.json`.

`server-ip` sengaja kosong.

Jika `server.properties` sudah memiliki konfigurasi lain, runtime mempertahankan konfigurasi tersebut dan hanya memastikan property minimum di atas memiliki nilai yang diperlukan.

## Automatic Download

Untuk setiap instance:

```text
servers/java/<id>/server.jar
```

Jika `server.jar` belum ada, runtime mengambil server Vanilla resmi dari Mojang.

Jika sudah ada, runtime tidak mendownload ulang kecuali checksum SHA-1 dari metadata Mojang tidak cocok.

Metadata versi disimpan di:

```text
servers/java/<id>/version-meta.json
```

## Multi-Version / Multi-Instance

Contoh:

```json
{
  "host": "0.0.0.0",
  "servers": [
    {
      "id": "survival-1218",
      "platform": "java",
      "version": "1.21.8",
      "port": 25565,
      "memory": "2G"
    },
    {
      "id": "old-1201",
      "platform": "java",
      "version": "1.20.1",
      "port": 25566,
      "memory": "2G"
    },
    {
      "id": "legacy-1211",
      "platform": "java",
      "version": "1.21.1",
      "port": 25567,
      "memory": "3G"
    }
  ]
}
```

Folder menjadi:

```text
servers/
└── java/
    ├── survival-1218/
    │   ├── server.jar
    │   ├── eula.txt
    │   ├── server.properties
    │   ├── version-meta.json
    │   └── world/
    │
    ├── old-1201/
    │   ├── server.jar
    │   ├── eula.txt
    │   ├── server.properties
    │   └── world/
    │
    └── legacy-1211/
        ├── server.jar
        ├── eula.txt
        ├── server.properties
        └── world/
```

Jangan menggunakan port yang sama untuk dua instance.

Saat lebih dari satu Java server dikonfigurasi, command harus menyebutkan ID.

Contoh:

```text
java survival-1218 list
java old-1201 list
java legacy-1211 say Hello
```

Jika hanya ada satu Java server, bentuk pendek tetap bisa digunakan:

```text
java list
java say Hello
java time set day
java stop
```

## Console Commands

Setelah:

```bash
npm start
```

gunakan:

```text
status
```

Contoh:

```text
JAVA survival-1218: RUNNING
BEDROCK: STOPPED
```

Kirim command ke Java:

```text
java list
java say Hello
java time set day
java op PlayerName
java stop
```

Dengan multiple Java servers:

```text
java survival-1218 list
java old-1201 say Hello
```

Runtime akan mengirim hanya bagian command Minecraft ke stdin server.

## Exit / Graceful Shutdown

Ketik:

```text
exit
```

Runtime akan:

1. mengirim `stop` ke Java
2. menunggu Java berhenti
3. menghentikan Bedrock jika aktif
4. jika proses tidak berhenti setelah timeout, melakukan termination
5. kemudian Node.js exit

`Ctrl+C` juga menjalankan graceful shutdown.

SIGTERM juga ditangani.

## Network

Java:

```text
TCP 25565
```

Bedrock:

```text
UDP 19132
```

Port dapat diubah melalui config.

Contoh:

```json
"port": 25566
```

Untuk server yang berjalan di mesin lain/device lain, pastikan firewall Linux/router mengizinkan port yang digunakan.

Contoh UFW untuk Java:

```bash
sudo ufw allow 25565/tcp
```

Bedrock:

```bash
sudo ufw allow 19132/udp
```

Jika tidak menggunakan UFW, sesuaikan dengan firewall yang digunakan.

## Bedrock

Bedrock default disabled:

```json
"enabled": false
```

Runtime tidak mendownload Bedrock binary.

Gunakan binary Bedrock Dedicated Server yang diperoleh dari sumber resmi/lisensi yang sesuai.

Letakkan binary di:

```text
servers/bedrock/bedrock_server
```

Kemudian:

```bash
chmod +x servers/bedrock/bedrock_server
```

Aktifkan:

```json
"bedrock": {
  "enabled": true,
  "port": 19132,
  "serverDir": "./servers/bedrock",
  "binary": "./servers/bedrock/bedrock_server"
}
```

Runtime akan menjalankannya sebagai child process.

## Important Bedrock Note

Bedrock Dedicated Server menentukan pengaturan network melalui konfigurasi Bedrock-nya sendiri. Runtime menyediakan `port` pada config untuk struktur/configuration planning, tetapi tidak memodifikasi binary atau mendownload binary tersebut.

Pastikan `server.properties` Bedrock menggunakan port UDP yang diinginkan.

## Logs

Java diberi prefix:

```text
[JAVA:survival-1218]
```

Bedrock:

```text
[BEDROCK]
```

Contoh:

```text
[14:30:01] MC Runtime starting...
[14:30:01] Java detected: 21.0.12.1
[14:30:02] Loading Mojang version manifest...
[14:30:02] server.jar found for survival-1218.
[14:30:02] Starting Java server "survival-1218"...
[JAVA:survival-1218] Starting Minecraft server...
```

## Error Handling

Runtime menangani kondisi seperti:

- Java tidak ditemukan
- Node.js terlalu lama
- config tidak valid
- duplicate server ID
- duplicate Java port
- Minecraft version tidak ditemukan
- Mojang manifest gagal diakses
- metadata versi gagal diakses
- server download gagal
- checksum server.jar tidak cocok
- EULA belum diterima
- server process error
- server crash/exit
- Bedrock binary tidak ditemukan
- Bedrock binary tidak executable
- shutdown melalui SIGINT/SIGTERM

## Security

Runtime CLI ini tidak menyediakan web panel atau REST API.

Jangan menjalankan Minecraft server sebagai root kecuali memang diperlukan.

Disarankan membuat user Linux khusus untuk server Minecraft.

Contoh konsep:

```bash
sudo adduser minecraft
```

Kemudian jalankan runtime sebagai user tersebut.

## Folder Structure

```text
mc-runtime/
├── package.json
├── config.json
├── server.js
├── README.md
├── .gitignore
└── servers/
    ├── java/
    │   └── <server-id>/
    │       ├── server.jar
    │       ├── eula.txt
    │       ├── server.properties
    │       ├── version-meta.json
    │       └── world/
    │
    └── bedrock/
        └── bedrock_server
```

World dan file server setiap instance terisolasi di folder masing-masing.

## Quick Start

```bash
cd mc-runtime
node -v
java -version
npm start
```

First run akan membuat EULA:

```bash
nano servers/java/survival-1218/eula.txt
```

ubah:

```text
eula=false
```

menjadi:

```text
eula=true
```

Lalu:

```bash
npm start
```

Console:

```text
status
java list
java say Hello
exit
```

## Mojang Downloads

Java server jar diperoleh menggunakan Mojang's official version manifest:

```text
https://piston-meta.mojang.com/mc/game/version_manifest_v2.json
```

Runtime tidak memakai server jar pihak ketiga.
