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
// FUNGSI BANTUAN TANGGAL & BULK INSERT PPA
// ==============================================================================
function parseDateTimeParts(timestamp) {
    if (typeof timestamp === 'string') {
        const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
        if (match) {
            return {
                month: match[2],
                day: match[3],
                hour: match[4],
                minute: match[5]
            };
        }
    }
    const dateObj = timestamp ? new Date(timestamp) : new Date();
    const validDate = isNaN(dateObj.getTime()) ? new Date() : dateObj;
    return {
        month: String(validDate.getMonth() + 1).padStart(2, '0'),
        day: String(validDate.getDate()).padStart(2, '0'),
        hour: String(validDate.getHours()).padStart(2, '0'),
        minute: String(validDate.getMinutes()).padStart(2, '0')
    };
}

async function insertBulkIgnorePpa(rows) {
    if (!rows || rows.length === 0) return;
    const placeholders = rows.map(() => `(
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        NOW(), ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?
    )`).join(', ');

    const flatValues = rows.flat();
    const sql = `
        INSERT IGNORE INTO tpms (
            devicename, tyrelength, macadd, model, ipaddress, timestamp, lat, lon, alt, speed, id_site,
            pressure_1, pressure_2, pressure_3, pressure_4, pressure_5, pressure_6,
            status_1, status_2, status_3, status_4, status_5, status_6,
            temperature_1, temperature_2, temperature_3, temperature_4, temperature_5, temperature_6,
            voltage_1, voltage_2, voltage_3, voltage_4, voltage_5, voltage_6,
            insert_time, uptime,
            temp_stat_1, temp_stat_2, temp_stat_3, temp_stat_4, temp_stat_5, temp_stat_6,
            press_stat_1, press_stat_2, press_stat_3, press_stat_4, press_stat_5, press_stat_6,
            pressure_unit, key_tpms
        ) VALUES ${placeholders}
    `;
    await poolSpm.query(sql, flatValues);
}

async function processPendingDataBulkPpa(pendingItems) {
    if (!pendingItems || pendingItems.length === 0) return;

    const siteCache = {};
    const batchSize = 50;
    let batchRows = [];

    for (const item of pendingItems) {
        const rawDev = item?.unitdata?.device_name ?? item?.unitdata?.devicename ?? item?.device_name ?? item?.devicename;
        const deviceName = rawDev ? String(rawDev).trim() : '';
        if (!deviceName || deviceName.toLowerCase() === 'null' || deviceName.toLowerCase() === 'undefined') {
            continue;
        }

        const d_unit = item?.unitdata || {};
        const d_gps = item?.gpsdata || {};
        const d_tyre = item?.tyredata || {};

        const ip_address = d_unit.ip_address || '';
        const id_site = parseInt(d_unit.id_site) || 0;
        const macadd = d_unit.sn_unit || '';
        const model = d_unit.unit_model || '';
        const uptime = d_unit.uptime || 0;
        const timestamp = d_gps.timestamp || new Date().toISOString().slice(0, 19).replace('T', ' ');

        const { month, day, hour, minute } = parseDateTimeParts(timestamp);
        const key = `${deviceName}${month}${day}${hour}${minute}`;

        const lat = d_gps.lat || 0;
        const lon = d_gps.lon || 0;
        const alt = d_gps.alt || 0;
        const speed = d_gps.speed || 0;

        const length_data = d_tyre.data_length !== undefined ? d_tyre.data_length : 5;
        const unit_pressure = d_tyre.pressure_unit ? d_tyre.pressure_unit.toUpperCase() : 'PSI';

        if (!siteCache[id_site]) {
            let front = 115, rear = 115;
            try {
                const [qs] = await poolCts.execute('SELECT front_press, rear_press FROM site WHERE id_site = ? LIMIT 1', [id_site]);
                if (qs.length > 0) {
                    if (qs[0].front_press) front = qs[0].front_press;
                    if (qs[0].rear_press) rear = qs[0].rear_press;
                }
            } catch {}
            siteCache[id_site] = { front, rear };
        }
        const { front, rear } = siteCache[id_site];

        let pressure = [], temperature = [], status = [], voltage = [];
        let pressstatfix = [], tempstatfix = [];

        for (let i = 0; i <= length_data; i++) {
            const tyre = (d_tyre.data && d_tyre.data[i]) ? d_tyre.data[i] : {};
            let tekanan = tyre.pressure !== undefined ? tyre.pressure : null;
            let suhu = tyre.temperature !== undefined ? tyre.temperature : null;

            pressure.push(tekanan);
            temperature.push(suhu);
            status.push(tyre.status ?? null);
            voltage.push(tyre.voltage ?? null);

            let tekanan_evaluasi = (unit_pressure === 'BAR' && !isNaN(tekanan)) ? (tekanan * 14.5038) : (tekanan || 0);
            let standar = (i <= 1) ? front : rear;

            let min = (id_site == 195) ? (60 - (60 * 0.1)) : (standar - (standar * 0.1));
            let max = (id_site == 195) ? 109 : (standar + (standar * 0.2));

            let press_stat = 0;
            if (tekanan_evaluasi < min) press_stat = 1;
            else if (tekanan_evaluasi >= min && tekanan_evaluasi <= max) press_stat = 2;
            else if (tekanan_evaluasi > max) press_stat = 3;
            pressstatfix.push(press_stat);

            let temp_stat = 0;
            if (suhu < 30) temp_stat = 1;
            else if (suhu >= 30 && suhu <= 74) temp_stat = 2;
            else if (suhu >= 75 && suhu <= 84) temp_stat = 3;
            else if (suhu > 84) temp_stat = 4;
            tempstatfix.push(temp_stat);
        }

        const row = [
            deviceName, length_data, macadd, model, ip_address, timestamp, lat, lon, alt, speed, id_site,
            pressure[0] ?? null, pressure[1] ?? null, pressure[2] ?? null, pressure[3] ?? null, pressure[4] ?? null, pressure[5] ?? null,
            status[0] ?? null, status[1] ?? null, status[2] ?? null, status[3] ?? null, status[4] ?? null, status[5] ?? null,
            temperature[0] ?? null, temperature[1] ?? null, temperature[2] ?? null, temperature[3] ?? null, temperature[4] ?? null, temperature[5] ?? null,
            voltage[0] ?? null, voltage[1] ?? null, voltage[2] ?? null, voltage[3] ?? null, voltage[4] ?? null, voltage[5] ?? null,
            uptime,
            tempstatfix[0] ?? null, tempstatfix[1] ?? null, tempstatfix[2] ?? null, tempstatfix[3] ?? null, tempstatfix[4] ?? null, tempstatfix[5] ?? null,
            pressstatfix[0] ?? null, pressstatfix[1] ?? null, pressstatfix[2] ?? null, pressstatfix[3] ?? null, pressstatfix[4] ?? null, pressstatfix[5] ?? null,
            unit_pressure, key
        ];

        batchRows.push(row);

        if (batchRows.length >= batchSize) {
            await insertBulkIgnorePpa(batchRows);
            batchRows = [];
        }
    }

    if (batchRows.length > 0) {
        await insertBulkIgnorePpa(batchRows);
    }
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

    // 1. MODE BULK: PENDING DATA (Sesuai gettpmsdata_ppa.php)
    if (iotData && iotData.type === 'pending_data') {
        const pendingItems = Array.isArray(iotData.data) ? iotData.data : [];
        logEvent('PPA', req, 'BULK', 'RECEIVED', `Processing ${pendingItems.length} pending items`);

        res.status(200).json({
            status: "success",
            message: "Pending data received and processing in background",
            total: pendingItems.length
        });

        (async () => {
            try {
                await processPendingDataBulkPpa(pendingItems);
                logEvent('PPA', req, 'BULK', 'SUCCESS', `Processed ${pendingItems.length} pending items`);
            } catch (err) {
                logEvent('PPA', req, 'BULK', 'ERROR', err.message);
            }
        })();
        return;
    }

    // 2. MODE REALTIME
    const rawDeviceName = iotData?.unitdata?.device_name ?? iotData?.unitdata?.devicename ?? iotData?.device_name ?? iotData?.devicename;
    const deviceName = rawDeviceName !== null && rawDeviceName !== undefined ? String(rawDeviceName).trim() : '';

    if (!deviceName || deviceName.toLowerCase() === 'null' || deviceName.toLowerCase() === 'undefined') {
        logEvent('PPA', req, 'UNKNOWN', 'IGNORED', 'devicename kosong atau tidak valid, response 200 OK (data diabaikan)');
        return res.status(200).send('OK');
    }

    const deviceNameLog = deviceName;

    try {
        const d_unit = iotData.unitdata || {};
        const d_gps = iotData.gpsdata || {};
        const d_tyre = iotData.tyredata || {};

        const timestamp = d_gps.timestamp || new Date().toISOString().slice(0, 19).replace('T', ' ');
        const { month, day, hour, minute } = parseDateTimeParts(timestamp);
        const key = `${deviceName}${month}${day}${hour}${minute}`;

        // Cek Duplikasi Terlebih Dahulu agar tidak memproses ulang / duplicate tapping
        const [cekRows] = await poolSpm.execute('SELECT idtpms FROM tpms WHERE key_tpms = ? LIMIT 1', [key]);
        if (cekRows.length > 0) {
            logEvent('PPA', req, deviceNameLog, 'DUPLICATE', `Key ${key} ignored`);
            return res.status(200).send(`Data dengan Key ${key} sudah ada. (PPA)`);
        }

        // 1. Ambil Standar Tekanan dari poolCts
        const id_site = parseInt(d_unit.id_site) || 0;
        const [siteRows] = await poolCts.execute('SELECT front_press, rear_press FROM site WHERE id_site = ? LIMIT 1', [id_site]);
        const dataStandar = siteRows.length > 0 ? siteRows[0] : {};
        const front = (dataStandar.front_press !== undefined && dataStandar.front_press !== null && dataStandar.front_press !== '') ? dataStandar.front_press : 115;
        const rear = (dataStandar.rear_press !== undefined && dataStandar.rear_press !== null && dataStandar.rear_press !== '') ? dataStandar.rear_press : 115;

        // Ambil data terakhir unit ini untuk dibandingkan (Fitur Auto-Tapping)
        const [lastRows] = await poolSpm.execute(
            'SELECT * FROM tpms WHERE devicename = ? ORDER BY timestamp DESC LIMIT 1',
            [deviceName]
        );
        const data_last = lastRows.length > 0 ? lastRows[0] : null;

        let pressure = [], temperature = [], status = [], voltage = [];
        let pressstatfix = [], tempstatfix = [];
        const unit_pressure = d_tyre.pressure_unit ? d_tyre.pressure_unit.toUpperCase() : 'PSI';

        const dataLength = d_tyre.data_length !== undefined ? d_tyre.data_length : (d_tyre.data ? d_tyre.data.length - 1 : 5);

        for (let i = 0; i <= dataLength; i++) {
            const tyre = (d_tyre.data && d_tyre.data[i]) ? d_tyre.data[i] : {};
            let tekanan = tyre.pressure !== undefined ? tyre.pressure : null;
            let suhu = tyre.temperature !== undefined ? tyre.temperature : null;

            pressure.push(tekanan);
            temperature.push(suhu);
            status.push(tyre.status ?? null);
            voltage.push(tyre.voltage ?? null);

            let tekanan_evaluasi = (unit_pressure === 'BAR' && !isNaN(tekanan)) ? (tekanan * 14.5038) : (tekanan || 0);
            let standar = (i <= 1) ? front : rear;

            let min = (id_site == 195) ? (60 - (60 * 0.1)) : (standar - (standar * 0.1));
            let max = (id_site == 195) ? 109 : (standar + (standar * 0.2));

            let press_stat = 0;
            if (tekanan_evaluasi < min) press_stat = 1;
            else if (tekanan_evaluasi >= min && tekanan_evaluasi <= max) press_stat = 2;
            else if (tekanan_evaluasi > max) press_stat = 3;
            pressstatfix.push(press_stat);

            let temp_stat = 0;
            if (suhu < 30) temp_stat = 1;
            else if (suhu >= 30 && suhu <= 74) temp_stat = 2;
            else if (suhu >= 75 && suhu <= 84) temp_stat = 3;
            else if (suhu > 84) temp_stat = 4;
            tempstatfix.push(temp_stat);

            // LOGIKA AUTO-TAPPING PPA (Sesuai gettpmsdata_ppa.php)
            if (i <= 5 && data_last && tekanan !== null) {
                const ix = i + 1;
                const current_stat = press_stat;
                const prev_stat = data_last[`press_stat_${ix}`];
                const prev_press = data_last[`pressure_${ix}`];

                const prev_unit = (data_last.pressure_unit && data_last.pressure_unit !== '')
                    ? data_last.pressure_unit.toUpperCase() : 'PSI';

                const prev_press_psi = (prev_unit === 'BAR' && !isNaN(prev_press) && prev_press !== null)
                    ? (prev_press * 14.5038) : prev_press;

                const different = (!isNaN(tekanan_evaluasi) && !isNaN(prev_press_psi) && prev_press_psi !== null)
                    ? (tekanan_evaluasi - prev_press_psi) : 0;

                if (prev_stat == 1 && current_stat == 2 && different >= 7 && prev_press > 0) {
                    try {
                        const press_now = tekanan;
                        let time_prev = data_last.timestamp;

                        const [normalRows] = await poolSpm.execute(
                            `SELECT timestamp FROM tpms 
                            WHERE devicename = ? 
                              AND press_stat_${ix} = 2 
                              AND timestamp < ? 
                            ORDER BY timestamp DESC 
                            LIMIT 1`,
                            [deviceName, timestamp]
                        );
                        const last_normal_time = normalRows.length > 0 ? normalRows[0].timestamp : null;

                        let lowRows = [];
                        if (last_normal_time) {
                            [lowRows] = await poolSpm.execute(
                                `SELECT timestamp FROM tpms 
                                WHERE devicename = ? 
                                  AND press_stat_${ix} = 1 
                                  AND pressure_${ix} > 0 
                                  AND timestamp > ? 
                                  AND timestamp <= ? 
                                ORDER BY timestamp ASC 
                                LIMIT 1`,
                                [deviceName, last_normal_time, timestamp]
                            );
                        } else {
                            [lowRows] = await poolSpm.execute(
                                `SELECT timestamp FROM tpms 
                                WHERE devicename = ? 
                                  AND press_stat_${ix} = 1 
                                  AND pressure_${ix} > 0 
                                  AND timestamp <= ? 
                                ORDER BY timestamp ASC 
                                LIMIT 1`,
                                [deviceName, timestamp]
                            );
                        }
                        if (lowRows.length > 0) {
                            time_prev = lowRows[0].timestamp;
                        }

                        const [cekTapping] = await poolSpm.execute(
                            'SELECT id FROM tapping_tpms WHERE devicename = ? AND posisi = ? AND timestamp_before = ? LIMIT 1',
                            [deviceName, ix, time_prev]
                        );

                        if (cekTapping.length === 0) {
                            await poolSpm.execute(
                                `INSERT INTO tapping_tpms 
                                (devicename, posisi, pressure_before, pressure_after, timestamp_before, timestamp_after, id_site, insert_time) 
                                VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
                                [deviceName, ix, prev_press, press_now, time_prev, timestamp, id_site]
                            );
                            logEvent('PPA', req, deviceNameLog, 'TAPPING', `Pos ${ix} recorded (prev: ${prev_press}, now: ${press_now})`);
                        }
                    } catch (tapErr) {
                        logEvent('PPA', req, deviceNameLog, 'TAPPING_ERROR', tapErr.message);
                    }
                }
            }
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
            deviceName, d_tyre.data_length, d_unit.sn_unit, d_unit.unit_model, d_unit.ip_address, timestamp,
            d_gps.lat || 0, d_gps.lon || 0, d_gps.alt || 0, d_gps.speed || 0, id_site,
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

    const rawDeviceName = iotData?.unitdata?.device_name ?? iotData?.unitdata?.devicename ?? iotData?.device_name ?? iotData?.devicename;
    const deviceName = rawDeviceName !== null && rawDeviceName !== undefined ? String(rawDeviceName).trim() : '';

    if (!deviceName || deviceName.toLowerCase() === 'null' || deviceName.toLowerCase() === 'undefined') {
        logEvent('CK', req, 'UNKNOWN', 'IGNORED', 'devicename kosong atau tidak valid, response 200 OK (data diabaikan)');
        return res.status(200).send('OK');
    }

    const deviceNameLog = deviceName;

    try {
        const d_unit = iotData.unitdata || {};
        const d_gps = iotData.gpsdata || {};
        const d_tyre = iotData.tyredata || {};

        let id_site = parseInt(d_unit.id_site) || 0;
        if (deviceName === 'CO2475') {
            id_site = 232;
        }

        const timestamp = d_gps.timestamp || new Date().toISOString().slice(0, 19).replace('T', ' ');
        const { day, hour, minute } = parseDateTimeParts(timestamp);
        const key = `${deviceName}${day}${hour}${minute}`;

        // Cek Duplikasi Terlebih Dahulu agar tidak memproses ulang / duplicate tapping
        const [cekRows] = await poolCts3.execute('SELECT idtpms FROM tpms WHERE key_tpms = ? LIMIT 1', [key]);
        if (cekRows.length > 0) {
            logEvent('CK', req, deviceNameLog, 'DUPLICATE', `Key ${key} ignored`);
            return res.status(200).send(`Data dengan Key ${key} sudah ada. (CK)`);
        }

        // 1. Ambil SN dari movement di poolCts
        const fetchMovement = async (posisi) => {
            const [rows] = await poolCts.execute(
                'SELECT sn, job FROM movement WHERE unit_number = ? AND posisi = ? AND site = ? ORDER BY id_movement DESC LIMIT 1',
                [deviceName, posisi, id_site]
            );
            return rows[0] || { sn: null, job: null };
        };

        const movements = await Promise.all([1, 2, 3, 4, 5, 6].map(fetchMovement));
        const rawSns = movements.map(m => m.sn || null);
        const sns = movements.map(m => String(m.job) === '1' ? m.sn : null);

        // 2. Ambil Rating dari cloud di poolCts
        let ratingMap = {};
        const validSns = sns.filter(sn => sn !== null);
        if (validSns.length > 0) {
            const placeholders = validSns.map(() => '?').join(',');
            const [ratingRows] = await poolCts.execute(`SELECT kunci, rating FROM cloud WHERE kunci IN (${placeholders})`, validSns);
            ratingRows.forEach(row => ratingMap[row.kunci] = row.rating);
        }

        // Ambil data terakhir unit ini untuk dibandingkan (Fitur Auto-Tapping)
        const [lastRows] = await poolCts3.execute(
            'SELECT * FROM tpms WHERE devicename = ? ORDER BY timestamp DESC LIMIT 1',
            [deviceName]
        );
        const data_last = lastRows.length > 0 ? lastRows[0] : null;

        let sensor_id = [], pressure = [], temperature = [], status = [], voltage = [];
        let pressstatfix = [], tempstatfix = [];

        // 3. Kalkulasi Matriks Ban & Logika Auto-Tapping CK (Sesuai gettpmsdata_ck.php)
        for (let i = 0; i <= 5; i++) {
            const tyre = (d_tyre.data && d_tyre.data[i]) ? d_tyre.data[i] : {};
            let tekanan = tyre.pressure !== undefined && tyre.pressure !== null ? Math.round(tyre.pressure) : null;
            let suhu = tyre.temperature !== undefined ? tyre.temperature : null;

            sensor_id.push(tyre.id_sensor ?? null);
            pressure.push(tekanan);
            temperature.push(suhu);
            status.push(tyre.status ?? null);
            voltage.push(tyre.voltage ?? null);

            let currentSn = sns[i];
            let rtg = ratingMap[currentSn] || null;

            let current_stat = 2;
            let current_remark = "Unknown";

            if (rtg === "X") {
                current_stat = (tekanan !== null && tekanan >= 107) ? 2 : 1;
                current_remark = (suhu !== null && suhu >= 29) ? 2 : 1;
            } else {
                let resMatriks = getTyreStatus(suhu, tekanan);
                current_stat = resMatriks.status;
                current_remark = resMatriks.remark;
            }

            pressstatfix.push(current_stat);
            tempstatfix.push(current_remark);

            // LOGIKA AUTO-TAPPING CK (Sesuai gettpmsdata_ck.php)
            if (data_last && tekanan !== null) {
                const ix = i + 1;
                const prev_stat = data_last[`press_stat_${ix}`];
                const prev_press = data_last[`pressure_${ix}`];
                const different = (prev_press !== null && prev_press !== undefined) ? (tekanan - prev_press) : 0;

                if (prev_stat == 1 && current_stat == 2 && different >= 7) {
                    try {
                        const sn_tapping = rawSns[i];
                        const press_now = tekanan;
                        const time_prev = data_last.timestamp;

                        const [cekTapping] = await poolCts3.execute(
                            'SELECT id FROM tapping_tpms WHERE devicename = ? AND posisi = ? AND timestamp_before = ? LIMIT 1',
                            [deviceName, ix, time_prev]
                        );

                        if (cekTapping.length === 0) {
                            await poolCts3.execute(
                                `INSERT INTO tapping_tpms 
                                (devicename, posisi, sn, pressure_before, pressure_after, timestamp_before, timestamp_after, id_site, insert_time) 
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                                [deviceName, ix, sn_tapping, prev_press, press_now, time_prev, timestamp, id_site]
                            );
                            logEvent('CK', req, deviceNameLog, 'TAPPING', `Pos ${ix} recorded (prev: ${prev_press}, now: ${press_now}, sn: ${sn_tapping})`);
                        }
                    } catch (tapErr) {
                        logEvent('CK', req, deviceNameLog, 'TAPPING_ERROR', tapErr.message);
                    }
                }
            }
        }

        // 4. Insert ke Database
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
            deviceName, d_unit.ip_address, timestamp, d_gps.lat || 0, d_gps.lon || 0, d_gps.alt || 0, d_gps.speed || 0, id_site,
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