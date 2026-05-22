const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios'); // Dibutuhkan untuk route site lain (fallback)
const app = express();

app.use(express.json());
const PORT = process.env.PORT || 3000;

// ==============================================================================
// SETUP 3 JALUR KONEKSI DATABASE (MULTI-POOL) MENGGUNAKAN IP SHARED HOSTING
// ==============================================================================
const HOST_IP = '103.229.73.124';

// Pool 1: Database CTS Induk (Untuk BACA tabel 'site' PPA & 'movement/cloud' CK)
const poolCts = mysql.createPool({
    host: HOST_IP,
    user: 'k6218892_root2', // root2 memiliki hak akses luas ke ctsmngr
    password: 'z;-y((MmfIm;1',
    database: 'k6218892_ctsmngr',
    waitForConnections: true, connectionLimit: 10, queueLimit: 0
});

// Pool 2: Database SPM (Untuk INSERT data khusus site PPA)
const poolSpm = mysql.createPool({
    host: HOST_IP,
    user: 'k6218892_spminsert',
    password: 'vt2R=IfBXaBo',
    database: 'k6218892_spm',
    waitForConnections: true, connectionLimit: 10, queueLimit: 0
});

// Pool 3: Database CTSMNGR3 (Untuk INSERT data khusus site CK)
const poolCts3 = mysql.createPool({
    host: HOST_IP,
    user: 'k6218892_savetpms',
    password: 'p06s3qK&aTMX',
    database: 'k6218892_ctsmngr3',
    waitForConnections: true, connectionLimit: 10, queueLimit: 0
});

// ==============================================================================
// FUNGSI BANTUAN UNTUK PENCATATAN LOG KE CONSOLE DOKPLOY
// ==============================================================================
function logEvent(site, req, deviceName, status, detail) {
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'UNKNOWN';

    // Format Waktu Lokal
    const now = new Date();
    const tzOffset = now.getTimezoneOffset() * 60000;
    const localTime = (new Date(now - tzOffset)).toISOString().slice(0, 19).replace('T', ' ');

    const logMessage = `[${localTime}] [${site}] IP: ${ip} | DEV: ${deviceName} | STAT: ${status} | DET: ${detail}`;

    if (status === 'ERROR' || status === 'FORWARD_ERROR') {
        console.error(logMessage); // Akan berwarna merah di beberapa terminal console
    } else {
        console.log(logMessage); // Akan berwarna standar
    }
}

// ==============================================================================
// FUNGSI BANTUAN UNTUK SITE CK: KALKULASI STATUS & REMARK MATRIKS SUHU BAN
// ==============================================================================
function getTyreStatus(suhu, tekanan) {
    let remark = "Unknown";
    let minPressure = null;
    let maxPressure = 250;
    let tempMatrix = suhu;

    for (let t = 18; t <= 95; t++) {
        if (suhu <= t) {
            tempMatrix = t;
            if (t <= 25) { remark = '1'; minPressure = 110; }
            else if (t <= 35) { remark = '2'; minPressure = 113; }
            else if (t <= 45) { remark = '2'; minPressure = 116; }
            else if (t <= 55) { remark = '2'; minPressure = 122; }
            else if (t <= 65) { remark = '2'; minPressure = 125; }
            else if (t <= 75) { remark = '2'; minPressure = 129; }
            else if (t <= 85) { remark = '4'; minPressure = 133; }
            else if (t <= 95) { remark = '4'; minPressure = 137; }
            break;
        }
    }

    let status = 2; // Default In Range
    if (tekanan !== null) {
        if (tekanan < minPressure) status = 1; // Low
        else if (tekanan > maxPressure) status = 3; // Over
    }

    return { remark, status, tempMatrix };
}


// ==============================================================================
// ENDPOINT 1: SITE PPA (BYPASS PHP & WEB SERVER)
// ==============================================================================
app.post('/ppa', async (req, res) => {
    const iotData = req.body;
    if (!iotData || Object.keys(iotData).length === 0) {
        logEvent('PPA', req, 'UNKNOWN', 'ERROR', 'No JSON data received');
        return res.status(400).json({ status: "error", message: "No data" });
    }

    const deviceNameLog = iotData?.unitdata?.device_name || 'UNKNOWN';

    try {
        const d_unit = iotData.unitdata;
        const d_gps = iotData.gpsdata;
        const d_tyre = iotData.tyredata;

        const timestamp = d_gps.timestamp;
        const dateObj = new Date(timestamp);
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const day = String(dateObj.getDate()).padStart(2, '0');
        const hour = String(dateObj.getHours()).padStart(2, '0');
        const minute = String(dateObj.getMinutes()).padStart(2, '0');
        const key = `${d_unit.device_name}${month}${day}${hour}${minute}`;

        // 1. Ambil Standar dari poolCts
        const [siteRows] = await poolCts.execute('SELECT front_press, rear_press FROM site WHERE id_site = ? LIMIT 1', [d_unit.id_site]);
        const dataStandar = siteRows.length > 0 ? siteRows[0] : {};
        const front = dataStandar.front_press || 115;
        const rear = dataStandar.rear_press || 115;

        let pressure = [], temperature = [], status = [], voltage = [];
        let pressstatfix = [], tempstatfix = [];
        const unit_pressure = d_tyre.pressure_unit ? d_tyre.pressure_unit.toUpperCase() : 'PSI';

        for (let i = 0; i <= d_tyre.data_length; i++) {
            const tyre = d_tyre.data[i] || {};
            let tekanan = tyre.pressure !== undefined ? tyre.pressure : null;
            let suhu = tyre.temperature !== undefined ? tyre.temperature : null;

            pressure.push(tekanan);
            temperature.push(suhu);
            status.push(tyre.status ?? null);
            voltage.push(tyre.voltage ?? null);

            let tekanan_evaluasi = (unit_pressure === 'BAR' && !isNaN(tekanan)) ? (tekanan * 14.5038) : (tekanan || 0);
            let standar = (i <= 1) ? front : rear;

            let min = standar - (standar * 0.1);
            let max = (d_unit.id_site == 195) ? 109 : standar + (standar * 0.2);
            if (d_unit.id_site == 195) min = 60 - (60 * 0.1);

            if (tekanan_evaluasi < min) pressstatfix.push(1);
            else if (tekanan_evaluasi >= min && tekanan_evaluasi <= max) pressstatfix.push(2);
            else if (tekanan_evaluasi > max) pressstatfix.push(3);
            else pressstatfix.push(0);

            if (suhu < 30) tempstatfix.push(1);
            else if (suhu >= 30 && suhu <= 74) tempstatfix.push(2);
            else if (suhu >= 75 && suhu <= 84) tempstatfix.push(3);
            else if (suhu > 84) tempstatfix.push(4);
            else tempstatfix.push(0);
        }

        // 2. Cek Duplikasi
        const [cekRows] = await poolSpm.execute('SELECT idtpms FROM tpms WHERE key_tpms = ? LIMIT 1', [key]);
        if (cekRows.length > 0) {
            logEvent('PPA', req, deviceNameLog, 'DUPLICATE', `Key ${key} ignored`);
            return res.status(200).send(`Data dengan Key ${key} sudah ada. (PPA)`);
        }

        // 3. Insert ke Database
        const sqlInsert = `
            INSERT INTO tpms (
                devicename, tyrelength, macadd, model, ipaddress, timestamp, lat, lon, alt, speed, id_site,
                pressure_1, pressure_2, pressure_3, pressure_4, pressure_5, pressure_6,
                status_1, status_2, status_3, status_4, status_5, status_6,
                temperature_1, temperature_2, temperature_3, temperature_4, temperature_5, temperature_6,
                voltage_1, voltage_2, voltage_3, voltage_4, voltage_5, voltage_6,
                insert_time, uptime,
                temp_stat_1, temp_stat_2, temp_stat_3, temp_stat_4, temp_stat_5, temp_stat_6,
                press_stat_1, press_stat_2, press_stat_3, press_stat_4, press_stat_5, press_stat_6,
                pressure_unit, key_tpms
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?, ?,
                NOW(), ?,
                ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?, ?,
                ?, ?
            )`;

        const values = [
            d_unit.device_name, d_tyre.data_length, d_unit.sn_unit, d_unit.unit_model, d_unit.ip_address, timestamp,
            d_gps.lat || 0, d_gps.lon || 0, d_gps.alt || 0, d_gps.speed || 0, d_unit.id_site,
            pressure[0], pressure[1], pressure[2], pressure[3], pressure[4], pressure[5],
            status[0], status[1], status[2], status[3], status[4], status[5],
            temperature[0], temperature[1], temperature[2], temperature[3], temperature[4], temperature[5],
            voltage[0], voltage[1], voltage[2], voltage[3], voltage[4], voltage[5],
            d_unit.uptime,
            tempstatfix[0], tempstatfix[1], tempstatfix[2], tempstatfix[3], tempstatfix[4], tempstatfix[5],
            pressstatfix[0], pressstatfix[1], pressstatfix[2], pressstatfix[3], pressstatfix[4], pressstatfix[5],
            unit_pressure, key
        ].map(v => v === undefined ? null : v);

        await poolSpm.execute(sqlInsert, values);

        logEvent('PPA', req, deviceNameLog, 'SUCCESS', `Inserted Key ${key}`);
        res.status(200).send(`Data PPA berhasil disimpan. Key: ${key}`);

    } catch (error) {
        logEvent('PPA', req, deviceNameLog, 'ERROR', error.message);
        res.status(500).json({
            status: "error",
            message: "Database Error at PPA",
            error_detail: error.message,
            sql_message: error.sqlMessage || null
        });
    }
});


// ==============================================================================
// ENDPOINT 2: SITE CK (BYPASS PHP & WEB SERVER)
// ==============================================================================
app.post('/ck', async (req, res) => {
    const iotData = req.body;
    if (!iotData || Object.keys(iotData).length === 0) {
        logEvent('CK', req, 'UNKNOWN', 'ERROR', 'No JSON data received');
        return res.status(400).json({ status: "error", message: "No data" });
    }

    const deviceNameLog = iotData?.unitdata?.device_name || 'UNKNOWN';

    try {
        const d_unit = iotData.unitdata;
        const d_gps = iotData.gpsdata;
        const d_tyre = iotData.tyredata;

        const timestamp = d_gps.timestamp;
        const dateObj = new Date(timestamp);
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const day = String(dateObj.getDate()).padStart(2, '0');
        const hour = String(dateObj.getHours()).padStart(2, '0');
        const minute = String(dateObj.getMinutes()).padStart(2, '0');
        const key = `${d_unit.device_name}${month}${day}${hour}${minute}`;

        // 1. Ambil SN
        const fetchMovement = async (posisi) => {
            const [rows] = await poolCts.execute(
                'SELECT sn, job FROM movement WHERE unit_number = ? AND posisi = ? AND site = ? ORDER BY id_movement DESC LIMIT 1',
                [d_unit.device_name, posisi, d_unit.id_site]
            );
            return rows[0] || { sn: null, job: null };
        };

        const movements = await Promise.all([1, 2, 3, 4, 5, 6].map(fetchMovement));
        const sns = movements.map(m => m.job === '1' ? m.sn : null);

        // 2. Ambil Rating
        let ratingMap = {};
        const validSns = sns.filter(sn => sn !== null);
        if (validSns.length > 0) {
            const placeholders = validSns.map(() => '?').join(',');
            const [ratingRows] = await poolCts.execute(`SELECT kunci, rating FROM cloud WHERE kunci IN (${placeholders})`, validSns);
            ratingRows.forEach(row => ratingMap[row.kunci] = row.rating);
        }

        let sensor_id = [], pressure = [], temperature = [], status = [], voltage = [];
        let pressstatfix = [], tempstatfix = [];

        // 3. Kalkulasi Matriks Ban
        for (let i = 0; i <= 5; i++) {
            const tyre = d_tyre.data[i] || {};
            let tekanan = tyre.pressure !== undefined ? Math.round(tyre.pressure) : null;
            let suhu = tyre.temperature !== undefined ? tyre.temperature : null;

            sensor_id.push(tyre.id_sensor ?? null);
            pressure.push(tekanan);
            temperature.push(suhu);
            status.push(tyre.status ?? null);
            voltage.push(tyre.voltage ?? null);

            let currentSn = sns[i];
            let rtg = ratingMap[currentSn] || null;

            if (rtg === "X") {
                pressstatfix.push((tekanan >= 107) ? 2 : 1);
                tempstatfix.push((suhu >= 29) ? 2 : 1);
            } else {
                let resMatriks = getTyreStatus(suhu, tekanan);
                pressstatfix.push(resMatriks.status);
                tempstatfix.push(resMatriks.remark);
            }
        }

        // 4. Cek Duplikasi
        const [cekRows] = await poolCts3.execute('SELECT idtpms FROM tpms WHERE key_tpms = ? LIMIT 1', [key]);
        if (cekRows.length > 0) {
            logEvent('CK', req, deviceNameLog, 'DUPLICATE', `Key ${key} ignored`);
            return res.status(200).send(`Data dengan Key ${key} sudah ada. (CK)`);
        }

        // 5. Insert ke Database
        const sqlInsert = `
            INSERT INTO tpms (
                devicename, ipaddress, timestamp, lat, lon, alt, speed, id_site,
                idsensor1, idsensor2, idsensor3, idsensor4, idsensor5, idsensor6,
                pressure_1, pressure_2, pressure_3, pressure_4, pressure_5, pressure_6,
                status_1, status_2, status_3, status_4, status_5, status_6,
                temperature_1, temperature_2, temperature_3, temperature_4, temperature_5, temperature_6,
                voltage_1, voltage_2, voltage_3, voltage_4, voltage_5, voltage_6,
                insert_time, uptime,
                sn1, sn2, sn3, sn4, sn5, sn6,
                temp_stat_1, temp_stat_2, temp_stat_3, temp_stat_4, temp_stat_5, temp_stat_6,
                press_stat_1, press_stat_2, press_stat_3, press_stat_4, press_stat_5, press_stat_6,
                key_tpms
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                NOW(), ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?
            )`;

        const values = [
            d_unit.device_name, d_unit.ip_address, timestamp, d_gps.lat || 0, d_gps.lon || 0, d_gps.alt || 0, d_gps.speed || 0, d_unit.id_site,
            sensor_id[0], sensor_id[1], sensor_id[2], sensor_id[3], sensor_id[4], sensor_id[5],
            pressure[0], pressure[1], pressure[2], pressure[3], pressure[4], pressure[5],
            status[0], status[1], status[2], status[3], status[4], status[5],
            temperature[0], temperature[1], temperature[2], temperature[3], temperature[4], temperature[5],
            voltage[0], voltage[1], voltage[2], voltage[3], voltage[4], voltage[5],
            d_unit.uptime,
            sns[0], sns[1], sns[2], sns[3], sns[4], sns[5],
            tempstatfix[0], tempstatfix[1], tempstatfix[2], tempstatfix[3], tempstatfix[4], tempstatfix[5],
            pressstatfix[0], pressstatfix[1], pressstatfix[2], pressstatfix[3], pressstatfix[4], pressstatfix[5],
            key
        ].map(v => v === undefined ? null : v);

        await poolCts3.execute(sqlInsert, values);

        logEvent('CK', req, deviceNameLog, 'SUCCESS', `Inserted Key ${key}`);
        res.status(200).send(`Data CK berhasil disimpan. Key: ${key}`);

    } catch (error) {
        logEvent('CK', req, deviceNameLog, 'ERROR', error.message);
        res.status(500).json({
            status: "error",
            message: "Database Error at CK",
            error_detail: error.message,
            sql_message: error.sqlMessage || null
        });
    }
});


// ==============================================================================
// ENDPOINT 3: FALLBACK AXIOS UNTUK SITE LAIN (VALE, RCI, IDTR, DLL)
// ==============================================================================
const TARGET_MAP = {
    'vale': 'http://cts-chitraparatama.co.id/ChitraTireMngr/spm_vale/gettpmsdata.php',
    'rci': 'http://cts-chitraparatama.co.id/ChitraTireMngr/spm_rci/gettpmsdata.php',
    'idtr': 'http://cts-chitraparatama.co.id/ChitraTireMngr/spm_idtr/gettpmsdata.php'
};

app.post('/:siteCode', async (req, res) => {
    const siteCode = req.params.siteCode;
    const targetUrl = TARGET_MAP[siteCode];

    if (!targetUrl) {
        logEvent(siteCode.toUpperCase(), req, 'UNKNOWN', 'ERROR', 'Route not configured');
        return res.status(404).json({ status: "error", message: `Route '/${siteCode}' not configured.` });
    }

    const iotData = req.body;
    const deviceNameLog = iotData?.unitdata?.device_name || 'UNKNOWN';

    if (!iotData || Object.keys(iotData).length === 0) {
        logEvent(siteCode.toUpperCase(), req, deviceNameLog, 'ERROR', 'No JSON data received');
        return res.status(400).json({ status: "error", message: "No data received" });
    }

    try {
        const response = await axios.post(targetUrl, iotData, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 120000
        });

        logEvent(siteCode.toUpperCase(), req, deviceNameLog, 'FORWARD_SUCCESS', `Status: ${response.status}`);
        res.status(response.status).send(response.data);

    } catch (error) {
        logEvent(siteCode.toUpperCase(), req, deviceNameLog, 'FORWARD_ERROR', error.message);

        if (error.response) res.status(error.response.status).send(error.response.data);
        else if (error.code === 'ECONNABORTED') res.status(504).json({ status: "error", message: "Target server timeout" });
        else res.status(500).json({ status: "error", message: "Internal Relay Error", detail: error.message });
    }
});

// ==============================================================================
// SERVER RUN
// ==============================================================================
app.get('/', (req, res) => res.send('IoT SPM Relay Service is Running (Multi-Pool Configured).'));

app.listen(PORT, () => console.log(`IoT Relay Service berjalan di port ${PORT}`));