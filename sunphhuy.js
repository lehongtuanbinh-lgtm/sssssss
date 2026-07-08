const axios = require('axios');
const fs = require('fs');
const path = require('path');
// --- Cấu hình & Khởi tạo ---
const API_URL = "https://apisunlon.onrender.com/sun";
const DATA_FILE = "collected_data/sunwin_tx.json";
const STATS_FILE = "database/stats.json";
// Các giới hạn
const MIN_DATA_FOR_PREDICTION = 10;  // Cần 10k phiên mới bắt đầu dự đoán
const MAX_PREDICTIONS = 100000;          // Dự đoán tối đa 100k phiên
const MAX_STORAGE = 1000000;             // Lưu trữ tối đa 1000k phiên
const vnNow = () => {
    const d = new Date();
    return new Date(d.getTime() + (7 * 60 * 60 * 1000)).toISOString();
};
let stats = {
    total: 0, correct: 0, wrong: 0,
    last_prediction: null,
    start_time: vnNow(),
    history: [],
    total_predictions_made: 0,
    prediction_started: false  // Đánh dấu đã bắt đầu dự đoán chưa
};
class TX_LogicPen_V4 {
    constructor() {
        this.error_streak = 0;
        this.last_prediction = null;
        this.history = [];
        // ========== NÂNG CẤP MỚI - BIẾN THEO DÕI TRẠNG THÁI ==========
        this.co_khuon_cau = false;       // Đánh dấu hiện tại có vào khuôn hay không
        this.ten_khuon = "";              // Tên khuôn đang bắt
        this.dao_tu_dong_trang_thai = false; // Trạng thái chế độ đảo liên tục
        // ==============================================================
    }
    loadData(data) {
        this.history = [...data].sort((a, b) => (b.phien || 0) - (a.phien || 0));
    }
    _arr() {
        return this.history.map(s => 
            (s.ket_qua || '').toUpperCase().replace('XỈU', 'XIU').replace('TÀI', 'TAI')
        );
    }
    _points() {
        return this.history
            .filter(s => s.tong !== undefined && s.tong !== null)
            .map(s => s.tong);
    }

    // ========== NÂNG CẤP MỚI: ƯU TIÊN CAO NHẤ - 3 LIÊN TIẾP BẮT BỆT ==========
    cau3Bet(arr) {
        if (arr.length < 3) return null;
        // Phát hiện chính xác 3 TÀI hoặc 3 XỈU liên tiếp ở đầu chuỗi mới nhất
        if (arr[0] === arr[1] && arr[1] === arr[2]) {
            return { 
                pred: arr[0], 
                conf: 86, 
                type: "BẮT BỆT 3", 
                reason: `✅ 3 ${arr[0]} LIÊN TIẾP → BẮT BỆT KHÔNG BẺ` 
            };
        }
        return null;
    }
    // ========================================================================

    cauSap(arr) {
        if (arr.length < 2) return null;
        let length = 1;
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] === arr[0]) length++;
            else break;
        }
        if (length >= 2 && length <= 5) {
            return { pred: arr[0], conf: 72, type: "Đu Bệt", reason: `Bệt ${length} phiên` };
        }
        if (length >= 6) {
            return { pred: arr[0] === "TAI" ? "XIU" : "TAI", conf: 80, type: "Bẻ Bệt Rồng", reason: `Bệt dài ${length} → hồi` };
        }
        return null;
    }

    // ========== NÂNG CẤP MỚI: Cầu 1‑1 cứng, không bẻ, ưu tiên rất cao ==========
    cauNoi(arr) {
        if (arr.length < 5) return null;
        // Kiểm tra nhịp 1‑1 hoàn hảo: T X T X T / X T X T X → KHÔNG BẺ, BẮT LUÔN NHỊP
        let laCau11 = true;
        for (let i = 0; i < 4; i++) {
            if (arr[i] === arr[i + 1]) {
                laCau11 = false;
                break;
            }
        }
        if (laCau11) {
            // Bắt tiếp nhịp cũ: nếu đầu là T → kế là X, đầu là X → kế là T
            const ketQuaBat = arr[0] === "TAI" ? "XIU" : "TAI";
            return { 
                pred: ketQuaBat, 
                conf: 88, 
                type: "CẦU NỐI 1‑1 CỨNG", 
                reason: "⚡ NHỊP 1‑1 ỔN ĐỊNH → BẮT THEO NHỊP KHÔNG BẺ" 
            };
        }
        return null;
    }
    // ========================================================================

    cauDoi(arr) {
        if (arr.length < 4) return null;
        if (arr[0] === arr[1] && arr[2] === arr[3] && arr[0] !== arr[2]) {
            return { pred: arr[2], conf: 78, type: "Cầu 2‑2", reason: "AABB → B" };
        }
        if (arr.length >= 6 && arr[0] === arr[1] && arr[1] === arr[2] && 
            arr[3] === arr[4] && arr[4] === arr[5] && arr[0] !== arr[3]) {
            return { pred: arr[3], conf: 80, type: "Cầu 3‑3", reason: "AAABBB → B" };
        }
        return null;
    }
    cauGay(arr) {
        if (arr.length >= 5 && arr[0] === arr[1] && arr[1] === arr[2] && arr[2] !== arr[3] && arr[3] === arr[4]) {
            return { pred: arr[3], conf: 74, type: "Gãy 3‑2", reason: "AAABB → B" };
        }
        if (arr.length >= 5 && arr[0] === arr[1] && arr[1] !== arr[2] && arr[2] === arr[3] && arr[3] === arr[4]) {
            return { pred: arr[2], conf: 74, type: "Gãy 2‑3", reason: "AABBB → B" };
        }
        if (arr.length >= 4 && arr[0] !== arr[1] && arr[1] === arr[2] && arr[2] !== arr[3] && arr[0] === arr[3]) {
            return { pred: arr[1], conf: 72, type: "Gãy 1‑2‑1", reason: "ABBA → B" };
        }
        return null;
    }
    phatHienMauLap(arr) {
        if (arr.length < 6) return null;
        for (let len = 2; len <= 4; len++) {
            let pattern = arr.slice(0, len);
            for (let i = len; i < arr.length - len; i++) {
                let sub = arr.slice(i, i + len);
                if (JSON.stringify(sub) === JSON.stringify(pattern) && arr[i - 1]) {
                    return { pred: arr[i - 1], conf: 88, type: "Mẫu Lặp", reason: `Mẫu "${pattern.join(',')}"` };
                }
            }
        }
        return null;
    }
    duDoanVi() {
        const points = this._points();
        if (points.length < 5) return null;
        const last = points[0], prev = points[1];
        const slice = points.slice(0, 5);
        const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
        if (last >= 15) return { pred: "XIU", conf: 75, type: "Vị cực đại", reason: `Điểm ${last} → hồi Xỉu` };
        if (last <= 5) return { pred: "TAI", conf: 75, type: "Vị cực tiểu", reason: `Điểm ${last} → hồi Tài` };
        if (avg > 11 && last > prev) return { pred: "XIU", conf: 68, type: "Vị bão hòa", reason: "Đà tăng chạm ngưỡng" };
        if (avg < 10 && last < prev) return { pred: "TAI", conf: 68, type: "Vị cạn kiệt", reason: "Đà giảm chạm đáy" };
        if (avg >= 11 && last >= 11 && last <= 13) return { pred: "TAI", conf: 65, type: "Vị ổn định", reason: "Duy trì Tài nhẹ" };
        if (avg <= 9 && last >= 7 && last <= 9) return { pred: "XIU", conf: 65, type: "Vị ổn định", reason: "Duy trì Xỉu nhẹ" };
        return null;
    }
    tongHopDuDoan() {
        const arr = this._arr();
        if (arr.length < 2) return null;

        // ========== NÂNG CẤP MỚI: SẮP XẾP ƯU TIÊN ĐÚNG YÊU CẦU ==========
        // 1. ƯU TIÊN SỐ 1 → 3 liên tiếp = bắt bệt
        // 2. ƯU TIÊN SỐ 2 → cầu 1‑1 = bắt nhịp cứng
        // 3. Tiếp theo tất cả các khuôn khác: mẫu lặp, cầu đối, cầu gãy, cầu sắp, vị điểm
        // 4. Cuối cùng mới là dự đoán mặc định
        const ketQuaKhuon = 
            this.cau3Bet(arr) ||
            this.cauNoi(arr) ||
            this.phatHienMauLap(arr) || 
            this.cauDoi(arr) ||
            this.cauGay(arr) || 
            this.cauSap(arr) || 
            this.duDoanVi(arr);

        if (ketQuaKhuon) {
            // ✅ CÓ KHUÔN → ĐÁNH DẤU RÕ RÀNG, SẼ KHÔNG ĐẢO
            this.co_khuon_cau = true;
            this.ten_khuon = ketQuaKhuon.type;
            this.dao_tu_dong_trang_thai = false;
            return ketQuaKhuon;
        } else {
            // ❌ KHÔNG CÓ KHUÔN NÀO → BẬT CHẾ ĐỘ ĐẢO TỰ ĐỘNG LIÊN TỤC
            this.co_khuon_cau = false;
            this.ten_khuon = "KHÔNG CÓ KHUÔN";
            this.dao_tu_dong_trang_thai = true;
            return { pred: arr[0], conf: 55, type: "Theo", reason: "Bám phiên cuối" };
        }
        // ==============================================================
    }

    // ========== NÂNG CẤP HOÀN TOÀN CHẾ ĐỘ ĐẢO THEO YÊU CẦU ==========
    apDungDaoChieu(p) {
        if (!p || this.history.length < 1) return p;
        const currentResult = this._arr()[0];

        // ⛔ NGUYÊN TẮC CỨNG: NẾU ĐANG Ở KHUÔN BẤT KỲ → KHÔNG BAO GIỜ ĐẢO, DÙNG KẾT QUẢ THẬT
        if (this.co_khuon_cau === true) {
            return {
                ...p,
                conf: Math.min(92, p.conf + 2),
                reason: `🎯 [KHUÔN: ${this.ten_khuon}] → BẮT ĐÚNG, KHÔNG ĐẢO | ${p.reason}`
            };
        }

        // 🔄 CHỈ KHI HOÀN TOÀN KHÔNG CÓ KHUÔN → CỨ ĐẢO LIÊN TỤC MÃI, ĐẢO HOÀI
        if (this.dao_tu_dong_trang_thai === true) {
            const ketQuaDao = p.pred === "TAI" ? "XIU" : "TAI";
            return {
                ...p,
                pred: ketQuaDao,
                conf: Math.min(85, p.conf + 5),
                type: "ĐẢO TỰ ĐỘNG",
                reason: `🔄 [KHÔNG CÓ KHUÔN] → TỰ ĐỘNG ĐẢO: ${p.pred} ➜ ${ketQuaDao}`
            };
        }

        // Giữ logic đảo cũ dựa trên chuỗi sai làm dự phòng
        if (this.error_streak >= 2 && this.last_prediction && this.last_prediction !== currentResult) {
            return {
                ...p,
                pred: p.pred === "TAI" ? "XIU" : "TAI",
                conf: Math.min(88, p.conf + 10),
                reason: `🔄 Đảo dự phòng: ${p.reason}`
            };
        }
        return p;
    }
    // ==============================================================

    predict(data) {
        this.loadData(data);
        let result = this.tongHopDuDoan();
        if (result) result = this.apDungDaoChieu(result);
        else result = { pred: this._arr()[0] || "TAI", conf: 50, type: "Theo", reason: "Không đủ dữ liệu" };
        
        this.last_prediction = result.pred;
        return result;
    }
    updateStatus(actual) {
        if (this.last_prediction) {
            const a = actual.toUpperCase().replace('XỈU', 'XIU').replace('TÀI', 'TAI');
            if (this.last_prediction === a) this.error_streak = 0;
            else this.error_streak++;
        }
    }
}
const predictor = new TX_LogicPen_V4();
// --- Helper Functions ---
function loadHistory() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const content = fs.readFileSync(DATA_FILE, 'utf-8');
            const data = JSON.parse(content);
            return data.history || [];
        }
    } catch (e) {
        console.error(`Lỗi đọc file: ${e.message}`);
    }
    return [];
}
function saveHistory(history) {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    // Giới hạn lưu trữ tối đa MAX_STORAGE phiên
    const limitedHistory = history.slice(-MAX_STORAGE);
    
    fs.writeFileSync(DATA_FILE, JSON.stringify({ 
        history: limitedHistory,
        total_sessions: limitedHistory.length,
        max_storage: MAX_STORAGE,
        last_updated: vnNow()
    }, null, 2));
    
    console.log(`💾 Đã lưu ${limitedHistory.length}/${MAX_STORAGE} phiên dữ liệu`);
}
function saveStatsFile() {
    const dir = path.dirname(STATS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify({
        ...stats,
        total_predictions_made: stats.total_predictions_made,
        max_predictions: MAX_PREDICTIONS,
        min_data_required: MIN_DATA_FOR_PREDICTION,
        max_storage: MAX_STORAGE,
        prediction_started: stats.prediction_started,
        last_updated: vnNow()
    }, null, 2));
}
function autoVerify(history) {
    if (stats.last_prediction && history.length > 0) {
        const lp = stats.last_prediction;
        const latest = history[history.length - 1];
        
        if (latest.phien === lp.phien) {
            const actual = latest.ket_qua || '';
            if (actual) {
                stats.total++;
                const a = actual.toUpperCase().replace('XỈU', 'XIU').replace('TÀI', 'TAI');
                const p = lp.prediction.toUpperCase().replace('XỈU', 'XIU').replace('TÀI', 'TAI');
                const ok = p === a;
                if (ok) stats.correct++;
                else stats.wrong++;
                predictor.updateStatus(actual);
                stats.history.push({
                    phien: latest.phien,
                    prediction: lp.prediction,
                    actual: actual,
                    confidence: lp.confidence,
                    correct: ok,
                    timestamp: vnNow()
                });
                if (stats.history.length > 500) stats.history = stats.history.slice(-500);
                
                const acc = ((stats.correct / Math.max(stats.total, 1)) * 100).toFixed(1);
                console.log(`🔍 VERIFY #${latest.phien}: ${ok ? '✅ ĐÚNG' : '❌ SAI'} | Tỷ lệ: ${acc}% (${stats.correct}/${stats.total})`);
                
                stats.last_prediction = null;
                saveStatsFile();
            }
        }
    }
}
function autoPredict(history) {
    // Chỉ dự đoán nếu đã có đủ dữ liệu
    if (!stats.prediction_started) {
        if (history.length >= MIN_DATA_FOR_PREDICTION) {
            stats.prediction_started = true;
            console.log(`\n🎉 ĐÃ ĐỦ ${MIN_DATA_FOR_PREDICTION} PHIÊN DỮ LIỆU! BẮT ĐẦU DỰ ĐOÁN...\n`);
        } else {
            const remaining = MIN_DATA_FOR_PREDICTION - history.length;
            console.log(`⏳ Đang thu thập dữ liệu: ${history.length}/${MIN_DATA_FOR_PREDICTION} phiên. Cần thêm ${remaining} phiên nữa để bắt đầu dự đoán.`);
            return;
        }
    }
    
    // Kiểm tra giới hạn dự đoán
    if (stats.total_predictions_made >= MAX_PREDICTIONS) {
        console.log(`🏁 Đã đạt giới hạn ${MAX_PREDICTIONS} dự đoán. Ngừng dự đoán mới.`);
        return;
    }
    
    if (history.length >= 5) {
        try {
            const r = predictor.predict(history);
            const cur = history[history.length - 1];
            let ph = cur.phien || 0;
            if (typeof ph === 'string') {
                const cleaned = ph.replace('#', '');
                ph = !isNaN(cleaned) ? parseInt(cleaned) : 0;
            }
            
            const nextPhien = ph + 1;
            stats.last_prediction = { 
                phien: nextPhien, 
                prediction: r.pred, 
                confidence: r.conf 
            };
            stats.total_predictions_made++;
            
            const remaining = MAX_PREDICTIONS - stats.total_predictions_made;
            console.log(`🎯 DỰ ĐOÁN #${nextPhien}: ${r.pred} | Độ tin cậy: ${r.conf}% | ${r.type} | Còn: ${remaining}/${MAX_PREDICTIONS}`);
            
            saveStatsFile();
        } catch (e) {
            console.error(`Lỗi dự đoán: ${e.message}`);
        }
    }
}
function safeInt(v, d = 0) {
    const parsed = parseInt(v);
    return isNaN(parsed) ? d : parsed;
}
// --- Main Collector ---
async function collect() {
    console.log("🚀 SUNWIN TX COLLECTOR - KHỞI ĐỘNG");
    console.log("═══════════════════════════════════════════");
    console.log(`📊 Yêu cầu dữ liệu tối thiểu: ${MIN_DATA_FOR_PREDICTION.toLocaleString()} phiên`);
    console.log(`🎯 Giới hạn dự đoán: ${MAX_PREDICTIONS.toLocaleString()} phiên`);
    console.log(`💾 Giới hạn lưu trữ: ${MAX_STORAGE.toLocaleString()} phiên`);
    console.log("⚙️  NÂNG CẤP: 3BET ƯU TIÊN | CẦU 1‑1 CỨNG | KHUÔN = KHÔNG ĐẢO | KHÔNG KHUÔN = ĐẢO LIÊN TỤC");
    console.log("═══════════════════════════════════════════\n");
    
    // Tải dữ liệu hiện có
    let history = loadHistory();
    console.log(`📚 Đã tải ${history.length.toLocaleString()} phiên dữ liệu hiện có`);
    
    // Khôi phục stats
    try {
        if (fs.existsSync(STATS_FILE)) {
            const savedStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
            stats = { ...stats, ...savedStats };
            if (stats.prediction_started) {
                console.log(`📈 Đã dự đoán ${stats.total_predictions_made.toLocaleString()}/${MAX_PREDICTIONS.toLocaleString()} phiên`);
                console.log(`📊 Tỷ lệ đúng: ${((stats.correct/Math.max(stats.total,1))*100).toFixed(1)}% (${stats.correct}/${stats.total})\n`);
            }
        }
    } catch (e) {}
    
    // Vòng lặp chính
    while (true) {
        try {
            const response = await axios.get(API_URL, { timeout: 15000 });
            if (response.status === 200) {
                const apiData = response.data.data || [];
                if (apiData.length > 0) {
                    let existing = new Set(history.map(h => h.phien));
                    let newSessions = [];
                    for (const item of apiData) {
                        const ph = safeInt(item.Phien);
                        if (ph <= 0 || existing.has(ph)) continue;
                        const newItem = {
                            phien: ph,
                            ket_qua: String(item.Ket_qua || ""),
                            tong: safeInt(item.Tong),
                            xuc_xac_1: safeInt(item.Xuc_xac_1),
                            xuc_xac_2: safeInt(item.Xuc_xac_2),
                            xuc_xac_3: safeInt(item.Xuc_xac_3)
                        };
                        
                        history.push(newItem);
                        existing.add(ph);
                        newSessions.push(newItem);
                    }
                    if (newSessions.length > 0) {
                        // Giới hạn lưu trữ
                        if (history.length > MAX_STORAGE) {
                            history = history.slice(-MAX_STORAGE);
                        }
                        
                        history.sort((a, b) => a.phien - b.phien);
                        saveHistory(history);
                        
                        const latest = history[history.length - 1];
                        const progress = `${history.length.toLocaleString()}/${MIN_DATA_FOR_PREDICTION.toLocaleString()}`;
                        console.log(`🎲 KQ #${latest.phien}: ${latest.ket_qua} | [${latest.xuc_xac_1},${latest.xuc_xac_2},${latest.xuc_xac_3}] = ${latest.tong} | Tiến độ: ${progress}`);
                        
                        autoVerify(history);
                        autoPredict(history);
                        
                        // Kiểm tra nếu đã đạt giới hạn dự đoán
                        if (stats.prediction_started && stats.total_predictions_made >= MAX_PREDICTIONS) {
                            console.log("\n🎯 ĐÃ ĐẠT GIỚI HẠN DỰ ĐOÁN!");
                            console.log(`📊 THỐNG KÊ CUỐI CÙNG:`);
                            console.log(`   Tổng dự đoán: ${stats.total_predictions_made}`);
                            console.log(`   Đúng: ${stats.correct}`);
                            console.log(`   Sai: ${stats.wrong}`);
                            console.log(`   Tỷ lệ: ${((stats.correct/Math.max(stats.total,1))*100).toFixed(2)}%`);
                            console.log("\n🛑 Kết thúc chương trình...");
                            process.exit(0);
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`❌ Lỗi: ${e.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
}
// Xử lý tắt chương trình
process.on('SIGINT', () => {
    console.log("\n🛑 Đang dừng chương trình...");
    saveStatsFile();
    console.log("✅ Đã lưu thống kê!");
    process.exit();
});
// Chạy Collector
collect().catch(console.error);