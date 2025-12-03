// --- CONFIGURACIÓN SUPABASE ---
const SUPABASE_URL = 'https://accwhbzrdwvlofxcdvix.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjY3doYnpyZHd2bG9meGNkdml4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ2NzMyODcsImV4cCI6MjA4MDI0OTI4N30.BFXlKhOf5r0JFp8sjoPZ6LbeDqyrdYO7KrXKjE2pY7o';

// Usamos 'sb' para evitar conflictos de nombres
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

function app() {
    return {
        habits: [],
        logs: {},
        notes: {},
        tempHabits: [],
        currentDate: new Date(),
        selectedDay: null,
        showSettings: false,
        savedMsg: false,
        viewMode: 'stats',
        mobileTab: 'today',
        refreshing: false,
        charts: {}, 
        chartsYear: {},
        sortableInstance: null,
        palette: ['#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#3b82f6', '#6366f1', '#84cc16', '#a855f7'],
        
        // SUPABASE AUTH VARS
        user: null,
        showAuthModal: false,
        authEmail: '',
        authPass: '',
        authMsg: '',
        isSyncing: false,
        saveTimeout: null,
        isAskingUser: false, // Semáforo para evitar doble ventana

        get daysInMonth() { return new Date(this.year, this.month + 1, 0).getDate(); },
        get blanks() { 
            const firstDayOfMonth = new Date(this.year, this.month, 1).getDay();
            return (firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1);
        },
        get month() { return this.currentDate.getMonth(); },
        get year() { return this.currentDate.getFullYear(); },
        get monthName() { return this.currentDate.toLocaleString('es-ES', { month: 'long' }); },
        get isMobile() { return window.innerWidth < 1024; },

        initApp() {
            // Carga Local
            const cfg = localStorage.getItem('trihabit_config_v17');
            const dat = localStorage.getItem('trihabit_logs_v17');
            const nts = localStorage.getItem('trihabit_notes_v17');

            if (cfg) {
                this.habits = JSON.parse(cfg);
                this.habits.forEach((h, i) => {
                    if (!h.days) h.days = [0,1,2,3,4,5,6];
                    if (!h.id) h.id = 'h-' + i + '-' + Date.now();
                });
                if(this.habits.length === 0) this.seedDefaultHabits();
            } else {
                this.seedDefaultHabits();
            }

            if (dat) this.logs = JSON.parse(dat);
            if (nts) this.notes = JSON.parse(nts);

            this.gotoToday();
            if(this.isMobile) this.mobileTab = 'today';
            this.$nextTick(() => { setTimeout(() => this.initChart(), 300); });
            
            // Iniciar Auth Supabase
            this.initAuth();
        },
        
        // --- AUTH Y SYNC SUPABASE ---
        async initAuth() {
            // CORRECCIÓN: Usamos solo el listener para evitar doble llamada al inicio
            sb.auth.onAuthStateChange(async (event, session) => {
                const prevUser = this.user;
                this.user = session ? session.user : null;
                
                // Solo descargamos si hay usuario y (es el inicio o acaba de loguearse)
                if(this.user && (!prevUser || event === 'SIGNED_IN')) {
                    await this.pullDataCloud();
                }
            });
        },

        async handleAuth(type) {
            this.authMsg = 'Procesando...';
            try {
                let result;
                if (type === 'signup') {
                    result = await sb.auth.signUp({ email: this.authEmail, password: this.authPass });
                    if (result.error) throw result.error;
                    this.authMsg = '¡Cuenta creada! Revisa tu email o entra.';
                    if(result.data.user) await this.handleAuth('signin');
                } else {
                    result = await sb.auth.signInWithPassword({ email: this.authEmail, password: this.authPass });
                    if (result.error) throw result.error;
                    this.showAuthModal = false;
                    this.authMsg = '';
                }
            } catch (error) { this.authMsg = error.message; }
        },

        async logout() {
            if(confirm('¿Cerrar sesión? Los datos locales se mantendrán.')) {
                await sb.auth.signOut();
                this.user = null;
            }
        },

        async pushDataCloud() {
            if (!this.user) return;
            this.savedMsg = false;
            // Solo enviamos lo básico
            const payload = {
                user_id: this.user.id,
                habits: this.habits,
                logs: this.logs,
                notes: this.notes,
                updated_at: new Date()
            };
            const { error } = await sb.from('user_data').upsert(payload);
            if (error) console.error('Error subiendo:', error);
            else console.log('☁️ Datos sincronizados en la nube');
        },

        // --- LÓGICA INTELIGENTE DE CONFLICTOS CORREGIDA ---
        async pullDataCloud() {
            if (!this.user || this.isAskingUser) return; // Evita reentradas
            this.isSyncing = true;
            
            // 1. Consultar Nube
            const { data, error } = await sb.from('user_data').select('*').eq('user_id', this.user.id).single();

            if (data) {
                // 2. ¿Tengo datos locales que merezca la pena salvar?
                const hasLocalData = Object.keys(this.logs).length > 0;
                
                let shouldDownload = true;

                // 3. Si hay datos locales Y datos en la nube, preguntamos
                if (hasLocalData) {
                    this.isAskingUser = true; // Bloqueamos otras llamadas
                    shouldDownload = confirm(
                        "⚠️ CONFLICTO DE DATOS DETECTADO\n\n" +
                        "Hay datos guardados en tu Nube, pero también tienes datos en este navegador.\n\n" +
                        "¿Qué deseas hacer?\n\n" +
                        "• ACEPTAR: Descargar los datos de la Nube (Recomendado si usas varios dispositivos para no perder progreso global).\n" +
                        "• CANCELAR: Usar los datos de este Navegador (Sobrescribirá lo que hay en la nube)."
                    );
                    this.isAskingUser = false; // Liberamos
                }

                if (shouldDownload) {
                    // Opción A: La nube gana
                    this.habits = data.habits || [];
                    this.logs = data.logs || {};
                    this.notes = data.notes || {};
                    
                    localStorage.setItem('trihabit_config_v17', JSON.stringify(this.habits));
                    localStorage.setItem('trihabit_logs_v17', JSON.stringify(this.logs));
                    localStorage.setItem('trihabit_notes_v17', JSON.stringify(this.notes));
                    
                    this.forceRedraw();
                    console.log('☁️ Datos descargados de la nube (Local sobrescrito)');
                } else {
                    // Opción B: El navegador gana
                    console.log('✋ Preferencia local. Subiendo a la nube para actualizarla...');
                    this.pushDataCloud();
                }
            }
            this.isSyncing = false;
        },

        seedDefaultHabits() {
            this.habits = [
                { id: 'h1', name: 'Ejercicio', max: 45, unit: 'min', color: this.palette[0], active: true, type: 'contador', days: [1,3,5] }, 
                { id: 'h2', name: 'Lectura', max: 20, unit: 'pag', color: this.palette[1], active: true, type: 'contador', days: [0,1,2,3,4,5,6] },
                { id: 'h3', name: 'Meditar', max: 1, unit: '', color: this.palette[2], active: true, type: 'check', days: [0,1,2,3,4,5,6] }
            ];
            for(let i=3; i<6; i++) {
                this.habits.push({ id: `h${i+1}`, name: `Hábito ${i+1}`, max: 1, unit: 'u', color: this.palette[i] || '#cbd5e1', active: false, type: 'check', days: [0,1,2,3,4,5,6] });
            }
        },

        saveData() {
            localStorage.setItem('trihabit_config_v17', JSON.stringify(this.habits));
            localStorage.setItem('trihabit_logs_v17', JSON.stringify(this.logs));
            localStorage.setItem('trihabit_notes_v17', JSON.stringify(this.notes));
            this.savedMsg = true;
            setTimeout(() => this.savedMsg = false, 1500);
            if (this.user) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = setTimeout(() => { this.pushDataCloud(); }, 1000);
            }
        },

        // --- UTILS BÁSICOS ---
        getKey(day) { return `${this.year}-${(this.month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`; },
        dateToKey(dateObj) { return `${dateObj.getFullYear()}-${(dateObj.getMonth() + 1).toString().padStart(2, '0')}-${dateObj.getDate().toString().padStart(2, '0')}`; },
        getVal(day, idx) { const key = this.getKey(day); return this.logs[key] ? (this.logs[key][idx] || 0) : 0; },
        
        getDayNote(day) { if (!day) return ''; const key = this.getKey(day); return this.notes[key] || ''; },
        updateDayNote(day, text) { const key = this.getKey(day); this.notes[key] = text; this.saveData(); },
        hasNote(day) { const key = this.getKey(day); return this.notes[key] && this.notes[key].trim().length > 0; },

        gotoToday() { 
            this.currentDate = new Date(); 
            this.selectedDay = this.currentDate.getDate(); 
            if(this.isMobile) this.mobileTab = 'today';
        },
        changeMonth(val) { this.currentDate = new Date(this.year, this.month + val, 1); this.selectedDay = null; this.forceRedraw(); },
        selectDay(day) { this.selectedDay = day; },
        
        changeDayOffset(offset) {
            const current = new Date(this.year, this.month, this.selectedDay);
            current.setDate(current.getDate() + offset);
            this.currentDate = current;
            this.selectedDay = current.getDate();
            this.forceRedraw(); 
        },

        isToday(day) { const t = new Date(); return day === t.getDate() && this.month === t.getMonth() && this.year === t.getFullYear(); },
        
        getDayClass(day) {
            if (this.selectedDay === day) return 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/40 ring-2 ring-indigo-400 transform scale-105 z-20';
            if (this.isToday(day)) return 'bg-slate-800 border border-indigo-500/50';
            return 'bg-slate-800/40 hover:bg-slate-700/80';
        },

        formatFullDate(day) {
            if (!day) return '';
            const d = new Date(this.year, this.month, day);
            const dateStr = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
            return dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
        },

        getDotStyle(day, idx, habit) {
            const dObj = new Date(this.year, this.month, day);
            const val = this.getVal(day, idx);
            const isRequired = habit.days.includes(dObj.getDay());

            if (val > 0) return `background: ${habit.color}`; 
            if (isRequired) return `background: ${habit.color}; opacity: 0.5`; 
            return 'display: none';
        },

        isHabitActiveToday(habit) {
            if (!this.selectedDay) return false;
            const dObj = new Date(this.year, this.month, this.selectedDay);
            return habit.days.includes(dObj.getDay());
        },

        updateVal(idx, val) {
            if (!this.selectedDay) return;
            const parsedVal = val === '' ? 0 : parseFloat(val);
            if (parsedVal < 0) return;
            const key = this.getKey(this.selectedDay);
            if (!this.logs[key]) this.logs[key] = [];
            const prevVal = this.logs[key][idx] || 0;
            if (prevVal < this.habits[idx].max && parsedVal >= this.habits[idx].max) { this.celebrate(); }
            this.logs[key][idx] = parsedVal;
            this.logs = { ...this.logs }; 
            this.saveData();
            if (this.viewMode === 'stats' && this.charts[idx] && this.charts[idx].data.datasets[0].data) {
                 if(this.charts[idx].data.datasets[0].data[this.selectedDay - 1] !== undefined) {
                    this.charts[idx].data.datasets[0].data[this.selectedDay - 1] = parsedVal;
                    this.charts[idx].update('none');
                 }
            }
            if (this.viewMode === 'year') this.forceRedraw(); 
        },

        toggleCheck(idx) { const current = this.getVal(this.selectedDay, idx); this.updateVal(idx, current >= 1 ? 0 : 1); },
        celebrate() { 
            if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
            confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 }, colors: ['#6366f1', '#ffffff'] }); 
        },

        // Stats Helpers
        checkHabitDone(dateObj, idx) {
            const habit = this.habits[idx];
            if (!habit.days.includes(dateObj.getDay())) return 'skip';
            const key = this.dateToKey(dateObj);
            const val = this.logs[key] ? (this.logs[key][idx] || 0) : 0;
            return val >= habit.max;
        },

        getCurrentStreak(idx) {
            let streak = 0;
            let d = new Date();
            for (let i = 0; i < 365; i++) {
                const status = this.checkHabitDone(d, idx);
                if (status === true) streak++;
                else if (status === false) {
                    const isToday = d.toDateString() === new Date().toDateString();
                    if (!isToday) break;
                }
                d.setDate(d.getDate() - 1);
            }
            return streak;
        },
        
        openSettings() {
            this.tempHabits = JSON.parse(JSON.stringify(this.habits));
            this.showSettings = true;
            this.$nextTick(() => { this.initSortable(); });
        },
        
        closeSettings() { this.showSettings = false; if (this.sortableInstance) this.sortableInstance.destroy(); },

        // --- FUNCIÓN AÑADIR HÁBITO ---
        addHabit() {
            this.tempHabits.push({
                id: 'h-' + Date.now(),
                name: 'Nuevo Hábito',
                max: 1,
                unit: 'vez',
                color: this.palette[Math.floor(Math.random() * this.palette.length)],
                active: true,
                type: 'check',
                days: [0,1,2,3,4,5,6]
            });
            // Hacemos scroll al final de la lista
            this.$nextTick(() => {
                const list = document.getElementById('habits-list');
                if(list) list.scrollTop = list.scrollHeight;
            });
        },

        initSortable() {
            const el = document.getElementById('habits-list');
            if (!el) return;
            this.sortableInstance = new Sortable(el, {
                handle: '.drag-handle',
                animation: 150,
                ghostClass: 'drag-ghost',
                chosenClass: 'drag-chosen',
                onEnd: (evt) => {
                    const movedItem = this.tempHabits.splice(evt.oldIndex - 1, 1)[0]; 
                    this.tempHabits.splice(evt.newIndex - 1, 0, movedItem);
                }
            });
        },

        toggleDay(habit, dayIdx) {
            if (habit.days.includes(dayIdx)) {
                if(habit.days.length > 1) habit.days = habit.days.filter(d => d !== dayIdx);
            } else {
                habit.days.push(dayIdx);
                habit.days.sort();
            }
        },

        saveSettings() {
            this.habits = JSON.parse(JSON.stringify(this.tempHabits));
            this.saveData();
            this.closeSettings();
            this.forceRedraw();
        },

        switchView(mode) {
            this.viewMode = mode;
            this.forceRedraw();
        },

        refreshCharts() {
            this.refreshing = true;
            this.forceRedraw();
            setTimeout(() => { this.refreshing = false; }, 500);
        },

        destroyCharts() {
            if (this.charts) {
                Object.values(this.charts).forEach(c => {
                    if(typeof c.destroy === 'function') c.destroy();
                });
            }
            this.charts = {};
            if (this.chartsYear) {
                Object.values(this.chartsYear).forEach(c => {
                    if(typeof c.destroy === 'function') c.destroy();
                });
            }
            this.chartsYear = {};
        },

        forceRedraw() {
            this.destroyCharts();
            this.$nextTick(() => {
                if (this.viewMode === 'stats') {
                    this.initChart();
                } else if (this.viewMode === 'year') {
                    this.initYearChart(); 
                    this.renderHeatmap();
                }
            });
        },

        renderHeatmap() {
            const container = document.getElementById('heatmap-container');
            if (!container) return;
            container.innerHTML = '';
            const today = new Date();
            const startDate = new Date();
            startDate.setDate(today.getDate() - 364);
            while(startDate.getDay() !== 1) { startDate.setDate(startDate.getDate() - 1); }

            let currentDate = new Date(startDate);
            while (currentDate <= today) {
                const dateKey = this.dateToKey(currentDate);
                let totalPotential = 0; let totalAchieved = 0;
                this.habits.forEach((h, i) => {
                    if (h.active && (h.days.includes(currentDate.getDay()) || (this.logs[dateKey] && this.logs[dateKey][i] > 0))) {
                        if (h.days.includes(currentDate.getDay())) totalPotential++;
                        
                        const val = this.logs[dateKey] ? (this.logs[dateKey][i] || 0) : 0;
                        if (val >= h.max) totalAchieved++;
                        else if (val > 0) totalAchieved += (val / h.max);
                    }
                });
                const intensity = totalPotential > 0 ? (totalAchieved / totalPotential) : 0;
                const cell = document.createElement('div');
                cell.className = 'heatmap-cell transition-all duration-300';
                let bg = 'rgba(30, 41, 59, 0.5)';
                if (intensity > 0) bg = '#0e4429';
                if (intensity > 0.25) bg = '#006d32';
                if (intensity > 0.5) bg = '#26a641';
                if (intensity > 0.75) bg = '#39d353';
                if (intensity > 1) bg = '#22c55e';
                
                cell.style.backgroundColor = bg;
                cell.title = `${currentDate.toLocaleDateString()}: ${Math.round(intensity*100)}%`;
                container.appendChild(cell);
                currentDate.setDate(currentDate.getDate() + 1);
            }
        },

        shareStats() {
            const element = document.getElementById('capture-area');
            const scrollContainer = document.getElementById('stats-scroll-container');
            if (!element) return;
            
            const originalOverflow = element.style.overflow;
            const originalHeight = element.style.height;
            const originalPadding = element.style.paddingBottom;
            
            let originalScrollClass = '';
            if (scrollContainer) {
                originalScrollClass = scrollContainer.className;
                scrollContainer.classList.remove('overflow-x-auto');
                scrollContainer.classList.add('flex-wrap');
            }
            
            element.style.overflow = 'visible';
            element.style.height = 'auto'; 
            element.style.paddingBottom = '50px'; 
            
            const flash = document.createElement('div');
            flash.className = 'fixed inset-0 bg-white z-[100] pointer-events-none transition-opacity duration-500';
            document.body.appendChild(flash);
            setTimeout(() => flash.classList.add('opacity-0'), 50);
            setTimeout(() => flash.remove(), 500);

            html2canvas(element, {
                backgroundColor: '#020617',
                scale: 2,
                windowHeight: element.scrollHeight + 200 
            }).then(canvas => {
                element.style.overflow = originalOverflow;
                element.style.height = originalHeight;
                element.style.paddingBottom = originalPadding;
                if (scrollContainer) {
                    scrollContainer.className = originalScrollClass;
                }

                const link = document.createElement('a');
                link.download = `trihabit-stats-${this.dateToKey(new Date())}.png`;
                link.href = canvas.toDataURL();
                link.click();
            }).catch(() => {
                element.style.overflow = originalOverflow;
                element.style.height = originalHeight;
                element.style.paddingBottom = originalPadding;
                if (scrollContainer) {
                    scrollContainer.className = originalScrollClass;
                }
            });
        },

        exportData() {
            const data = { config: this.habits, logs: this.logs, notes: this.notes, v: '3.1' };
            const blob = new Blob([JSON.stringify(data, null, 2)], {type : 'application/json'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = 'trihabit_backup.json'; a.click();
        },

        triggerImport() { this.$refs.fileInput.click(); },
        handleImport(e) {
            const f = e.target.files[0]; if(!f) return;
            const r = new FileReader();
            r.onload = (ev) => {
                try {
                    const d = JSON.parse(ev.target.result);
                    if(d.config && d.logs) {
                        if(confirm("Sobrescribir datos actuales?")) {
                            this.habits = d.config; this.logs = d.logs; 
                            if(d.notes) this.notes = d.notes;
                            this.saveData(); location.reload();
                        }
                    }
                } catch(x) { alert("Error archivo inválido"); }
            }; r.readAsText(f);
        },

        calcTotal(idx) {
            const prefix = `${this.year}-${(this.month+1).toString().padStart(2,'0')}`;
            return Object.keys(this.logs).filter(k => k.startsWith(prefix)).reduce((acc, k) => acc + (this.logs[k][idx] || 0), 0);
        },

        getCompletionRate(idx) {
            const habit = this.habits[idx];
            let potential = 0; let actual = 0;
            for(let i=1; i<=this.daysInMonth; i++) {
                const d = new Date(this.year, this.month, i);
                const isRequired = habit.days.includes(d.getDay());
                if (isRequired) potential += habit.max;
                actual += this.getVal(i, idx);
            }
            if (potential === 0) return 0;
            return (actual / potential) * 100;
        },

        getProgressText(idx) { return Math.round(this.getCompletionRate(idx)) + '% Completado'; },

        getYearlyTotal(idx) {
            const yearData = new Array(12).fill(0);
            const prefix = this.year + '-';
            Object.keys(this.logs).forEach(key => {
                if (key.startsWith(prefix)) {
                    const m = parseInt(key.split('-')[1]) - 1;
                    yearData[m] += (this.logs[key][idx] || 0);
                }
            });
            return yearData.reduce((a, b) => a + b, 0);
        },

        initChart() {
            this.habits.forEach((h, index) => {
                if (!h.active) return;
                const ctx = document.getElementById('chart-month-' + index);
                if (!ctx) return;
                const days = Array.from({length: this.daysInMonth}, (_, i) => i + 1);
                const vals = days.map(d => this.getVal(d, index));

                this.charts[index] = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: days,
                        datasets: [{
                            data: vals, borderColor: h.color, borderWidth: 2,
                            backgroundColor: (c) => {
                                const g = c.chart.ctx.createLinearGradient(0,0,0,200);
                                const color = h.color || '#6366f1';
                                g.addColorStop(0, color+'60'); 
                                g.addColorStop(1, color+'00'); 
                                return g;
                            },
                            fill: true, pointRadius: 0, pointHitRadius: 10
                        }]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        plugins: { legend: {display: false} },
                        scales: { x: {display: false}, y: {display: false, min: 0} },
                        animation: { duration: 0 }
                    }
                });
            });
        },

        initYearChart() {
            const months = ['E','F','M','A','M','J','J','A','S','O','N','D'];
            this.habits.forEach((h, index) => {
                if (!h.active) return;
                const ctx = document.getElementById('chart-year-' + index);
                if (!ctx) return;
                const data = new Array(12).fill(0);
                Object.keys(this.logs).forEach(k => { if(k.startsWith(this.year)) data[parseInt(k.split('-')[1])-1] += (this.logs[k][index]||0); });
                
                this.chartsYear[index] = new Chart(ctx, {
                    type: 'bar',
                    data: { labels: months, datasets: [{ data: data, backgroundColor: h.color, borderRadius: 3 }] },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        plugins: { legend: {display: false} },
                        scales: { x: { grid: {display:false}, ticks: {color: '#64748b'} }, y: { display: false } }
                    }
                });
            });
        },

        resetAll() { if(confirm("¿Borrar TODO? No hay vuelta atrás.")) { localStorage.clear(); location.reload(); } }
    }
}
