// ========================================
// MULTI-TENANT CONFIG
// ========================================

// CLINIC_PATH se setea al login según la clínica activa
// Ejemplo: 'clinica-smith', 'clinica-garcia', etc.
let CLINIC_PATH = null;
let unsubscribeSnapshot = null;

// Detectar clínica desde URL o localStorage
function detectClinica() {
    const urlParams = new URLSearchParams(window.location.search);
    const urlClinica = urlParams.get('clinica');
    if (urlClinica) {
        CLINIC_PATH = urlClinica;
        localStorage.setItem('smile_clinica', urlClinica);
        return urlClinica;
    }
    const saved = localStorage.getItem('smile_clinica');
    if (saved) {
        CLINIC_PATH = saved;
        return saved;
    }
    return null;
}

// Inicializar listener en tiempo real para la clínica activa
function initRealtimeListener() {
    if (unsubscribeSnapshot) unsubscribeSnapshot();

    unsubscribeSnapshot = db.collection('clinicas').doc(CLINIC_PATH).onSnapshot((doc) => {
        if (doc.exists && !doc.metadata.hasPendingWrites) {
            const data = doc.data();
            appData.facturas = data.facturas || [];
            appData.personal = data.personal || getDefaultPersonal();
            appData.gastos = data.gastos || [];
            appData.avances = data.avances || [];
            appData.cuadresDiarios = data.cuadresDiarios || {};
            appData.pacientes = data.pacientes || [];
            appData.citas = data.citas || [];
            appData.laboratorios = data.laboratorios || [];
            appData.reversiones = data.reversiones || [];
            appData.auditLogs = data.auditLogs || [];
            updateLocalCache();
            if (appData.currentUser) {
                const activeTab = document.querySelector('.tab-content.active');
                if (activeTab) {
                    const tabId = activeTab.id.replace('tab-', '');
                    if (tabId === 'ingresos') updateIngresosTab();
                    if (tabId === 'cobrar') updateCobrarTab();
                    if (tabId === 'cuadre') updateCuadreTab();
                    if (tabId === 'gastos') updateGastosTab();
                    if (tabId === 'personal') updatePersonalTab();
                    if (tabId === 'laboratorio') updateLaboratorioTab();
                    if (tabId === 'agenda') updateAgendaTab();
                    if (tabId === 'pacientes') updatePacientesTab();
                }
            }
        }
    });
}

// ========================================
// FIREBASE DATA MANAGEMENT
// ========================================

// Show sync indicator
function showSyncIndicator() {
    const indicator = document.getElementById('syncIndicator');
    if (indicator) {
        indicator.classList.add('show');
        setTimeout(() => indicator.classList.remove('show'), 2000);
    }
}

// Load data from Firebase
async function loadData() {
    try {
        // Intentar cargar desde caché primero (más rápido)
        const cached = localStorage.getItem('clinicaData_cache');
        const cacheTimestamp = localStorage.getItem('clinicaData_cacheTime');

        // Si hay caché reciente (menos de 5 minutos), usarlo temporalmente
        if (cached && cacheTimestamp) {
            const cacheAge = Date.now() - parseInt(cacheTimestamp);
            if (cacheAge < 5 * 60 * 1000) { // 5 minutos
                console.log('📦 Cargando desde caché local...');
                const cachedData = JSON.parse(cached);
                Object.assign(appData, cachedData);
                // Continuar cargando desde Firebase en background
            }
        }

        console.log('☁️ Cargando desde Firebase...');
        const doc = await db.collection('clinicas').doc(CLINIC_PATH).get();

        if (doc.exists) {
            const data = doc.data();
            appData.facturas = data.facturas || [];
            appData.personal = data.personal || getDefaultPersonal();
            appData.gastos = data.gastos || [];
            appData.avances = data.avances || [];
            appData.cuadresDiarios = data.cuadresDiarios || {};
            appData.citas = data.citas || [];
            appData.laboratorios = data.laboratorios || [];
            appData.reversiones = data.reversiones || [];
            appData.auditLogs = data.auditLogs || [];

            // Cargar pacientes desde subcollection si aplica
            if (data.usaSubcollectionPacientes) {
                console.log('📂 Cargando pacientes desde subcollection...');
                const pacientesSnapshot = await db.collection('clinicas').doc(CLINIC_PATH)
                    .collection('pacientes').get();
                appData.pacientes = pacientesSnapshot.docs.map(doc => doc.data());
                console.log(`✅ ${appData.pacientes.length} pacientes cargados desde subcollection`);
            } else {
                appData.pacientes = data.pacientes || [];
            }

            // Guardar en caché local
            updateLocalCache();

            // Limpiar/migrar datos antiguos automáticamente
            await limpiarDatosAntiguos();

            console.log('✅ Datos cargados desde Firebase');
        } else {
            appData.personal = getDefaultPersonal();
            await saveData();
        }
    } catch (error) {
        console.error('❌ Error loading from Firebase:', error);

        // Si falla, intentar usar caché aunque sea viejo
        const cached = localStorage.getItem('clinicaData_cache');
        if (cached) {
            console.log('⚠️ Usando caché de respaldo...');
            const cachedData = JSON.parse(cached);
            Object.assign(appData, cachedData);
        } else {
            appData.personal = getDefaultPersonal();
        }
    }
}

function updateLocalCache() {
    try {
        // Guardar copia en localStorage (sin placas para no llenar)
        const dataToCache = {
            facturas: appData.facturas,
            personal: appData.personal,
            gastos: appData.gastos,
            avances: appData.avances,
            cuadresDiarios: appData.cuadresDiarios,
            pacientes: appData.pacientes.map(p => ({
                ...p,
                placas: [] // No cachear placas (muy pesadas)
            })),
            citas: appData.citas,
            laboratorios: appData.laboratorios,
            reversiones: appData.reversiones,
            auditLogs: appData.auditLogs
        };

        localStorage.setItem('clinicaData_cache', JSON.stringify(dataToCache));
        localStorage.setItem('clinicaData_cacheTime', Date.now().toString());
    } catch (e) {
        console.warn('No se pudo guardar caché:', e);
        // Si localStorage está lleno, limpiar caché viejo
        localStorage.removeItem('clinicaData_cache');
    }
}

// Save data to Firebase
async function saveData() {
    try {
        console.log(`💾 Guardando datos en Firebase...`);
        console.log(`📊 Pacientes a guardar: ${appData.pacientes.length}`);

        // Calcular tamaño ANTES de guardar
        const dataSize = new Blob([JSON.stringify(appData)]).size;
        const sizeMB = (dataSize / (1024 * 1024)).toFixed(2);
        console.log(`📏 Tamaño total de datos: ${sizeMB} MB`);

        // Si hay muchos pacientes, guardarlos en subcollection
        if (appData.pacientes.length > 100) {
            console.log(`⚠️ Muchos pacientes (${appData.pacientes.length}). Usando subcollection...`);

            // Guardar datos principales SIN pacientes
            await db.collection('clinicas').doc(CLINIC_PATH).set({
                facturas: appData.facturas,
                personal: appData.personal,
                gastos: appData.gastos,
                avances: appData.avances,
                cuadresDiarios: appData.cuadresDiarios || {},
                pacientes: [], // Vacío - se guarda en subcollection
                citas: appData.citas || [],
                laboratorios: appData.laboratorios || [],
                reversiones: appData.reversiones || [],
                auditLogs: appData.auditLogs || [],
                lastUpdated: new Date().toISOString(),
                usaSubcollectionPacientes: true // Flag para saber que usa subcollection
            });

            console.log(`✅ Datos principales guardados`);
            console.log(`💾 Guardando ${appData.pacientes.length} pacientes en subcollection...`);

            // Guardar pacientes en lotes de 500 (límite de batch de Firebase)
            const BATCH_SIZE = 500;

            for (let i = 0; i < appData.pacientes.length; i += BATCH_SIZE) {
                const batch = db.batch(); // Crear nuevo batch para cada lote
                const lote = appData.pacientes.slice(i, Math.min(i + BATCH_SIZE, appData.pacientes.length));

                lote.forEach(paciente => {
                    const docRef = db.collection('clinicas').doc(CLINIC_PATH)
                        .collection('pacientes').doc(paciente.id);
                    batch.set(docRef, paciente);
                });

                await batch.commit();
                console.log(`✅ Guardados ${Math.min(i + BATCH_SIZE, appData.pacientes.length)}/${appData.pacientes.length} pacientes`);
            }

            console.log(`✅ Todos los pacientes guardados en subcollection`);
        } else {
            // Pocos pacientes, guardar normalmente
            await db.collection('clinicas').doc(CLINIC_PATH).set({
                facturas: appData.facturas,
                personal: appData.personal,
                gastos: appData.gastos,
                avances: appData.avances,
                cuadresDiarios: appData.cuadresDiarios || {},
                pacientes: appData.pacientes || [],
                citas: appData.citas || [],
                laboratorios: appData.laboratorios || [],
                reversiones: appData.reversiones || [],
                auditLogs: appData.auditLogs || [],
                lastUpdated: new Date().toISOString()
            });
        }

        console.log(`✅ Datos guardados exitosamente en Firebase`);

        // Actualizar caché local
        updateLocalCache();

        showSyncIndicator();
    } catch (error) {
        console.error('❌ ERROR CRÍTICO guardando en Firebase:', error);
        console.error('Código de error:', error.code);
        console.error('Mensaje:', error.message);

        // MOSTRAR ALERTA AL USUARIO
        alert(`❌ ERROR AL GUARDAR EN FIREBASE\n\n` +
              `Error: ${error.code}\n` +
              `Mensaje: ${error.message}\n\n` +
              `Los datos NO se guardaron. Revisa la configuración de Firebase.`);
    }
}

// Default personnel data
function getDefaultPersonal() {
    return [
        {id: '1', nombre: 'Dra. Elizabeth Smith', tipo: 'regular', password: 'admin123', isAdmin: true, canAccessReception: true},
        {id: '2', nombre: 'Susi', tipo: 'empleado', sueldo: 15000, password: 'susi123', canAccessReception: true, nextPayDate: null},
        {id: '3', nombre: 'Joelia', tipo: 'empleado', sueldo: 15000, password: 'joelia123', canAccessReception: true, nextPayDate: null}
    ];
}

// Real-time synchronization se inicializa en login() via initRealtimeListener()

// ========================================
// INITIALIZE APP
// ========================================

// Wait for Firebase to be ready, then load data
window.addEventListener('load', async function() {
    // Detectar clínica activa (URL o localStorage)
    const clinicaDetectada = detectClinica();

    if (!clinicaDetectada) {
        // Sin clínica detectada — mostrar pantalla de login de clínica
        // Por ahora: fallback a clinica-smith para compatibilidad
        CLINIC_PATH = 'clinica-smith';
        console.log('⚠️ Clínica no detectada, usando clinica-smith como fallback');
    }

    console.log(`🏥 Clínica activa: ${CLINIC_PATH}`);
    await loadData();
    updateProfessionalPicker();
    inicializarEstadosCitas();
});

// ========================================
// REST OF THE APP CODE
// ========================================

// Data Storage
let appData = {
    facturas: [],
    personal: [],
    gastos: [],
    avances: [],
    cuadresDiarios: {},
    pacientes: [],
    citas: [],
    laboratorios: [],
    currentUser: null,
    currentRole: null
};

let currentPersonalToEdit = null;
let currentReciboText = '';
let currentFacturaToReverse = null; // NUEVO: para reversar cobros

// Role selector
document.querySelectorAll('.role-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.role-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');

        const role = this.dataset.role;

        // Hide all first
        document.getElementById('professionalSelect').classList.add('hidden');
        document.getElementById('receptionSelect').classList.add('hidden');
        document.getElementById('usernameInput').classList.add('hidden');

        // Show correct one
        if (role === 'professional') {
            document.getElementById('professionalSelect').classList.remove('hidden');
        } else if (role === 'reception') {
            document.getElementById('receptionSelect').classList.remove('hidden');
            updateReceptionPicker();
        } else {
            document.getElementById('usernameInput').classList.remove('hidden');
        }
    });
});

// Update professional picker
function updateProfessionalPicker() {
    const picker = document.getElementById('professionalPicker');
    if (!picker) return;
    picker.innerHTML = '<option value="">-- Seleccionar --</option>';
    appData.personal.filter(p => p.tipo !== 'empleado').forEach(p => {
        picker.innerHTML += `<option value="${p.nombre}">${p.nombre}</option>`;
    });
}

// Update reception picker
function updateReceptionPicker() {
    const picker = document.getElementById('receptionPicker');
    if (!picker) return;
    picker.innerHTML = '<option value="">-- Seleccionar --</option>';
    appData.personal.filter(p => p.canAccessReception).forEach(p => {
        picker.innerHTML += `<option value="${p.nombre}">${p.nombre}</option>`;
    });
}

// Login
function login() {
    const roleBtn = document.querySelector('.role-btn.active');
    const role = roleBtn.dataset.role;
    const password = document.getElementById('password').value;
    let username = '';

    if (role === 'professional') {
        username = document.getElementById('professionalPicker').value;
        if (!username) {
            alert('Por favor selecciona un profesional');
            return;
        }
        const prof = appData.personal.find(p => p.nombre === username);
        if (!prof.password) {
            alert('Este profesional no tiene contraseña configurada');
            return;
        }
        if (prof.password !== password) {
            alert('Contraseña incorrecta');
            return;
        }
        appData.currentRole = 'professional';
    } else if (role === 'reception') {
        username = document.getElementById('receptionPicker').value;
        if (!username) {
            alert('Por favor selecciona un usuario');
            return;
        }
        const recep = appData.personal.find(p => p.nombre === username);
        if (!recep || !recep.canAccessReception) {
            alert('Usuario sin acceso a recepción');
            return;
        }
        if (recep.password !== password) {
            alert('Contraseña incorrecta');
            return;
        }
        appData.currentRole = 'reception';
    } else {
        username = document.getElementById('username').value;
        // Buscar admin por isAdmin flag
        const admin = appData.personal.find(p => p.isAdmin);
        if (!admin || password !== admin.password) {
            alert('Credenciales incorrectas');
            return;
        }
        username = admin.nombre;
        appData.currentRole = 'admin';
    }

    appData.currentUser = username;
    // Iniciar listener en tiempo real ahora que sabemos la clínica
    initRealtimeListener();
    showApp();
}

// Logout
function logout() {
    if (confirm('🚪 ¿Cerrar sesión?\n\nSe cerrará tu sesión actual.')) {
        // Cancelar listener de Firebase
        if (unsubscribeSnapshot) {
            unsubscribeSnapshot();
            unsubscribeSnapshot = null;
        }
        appData.currentUser = null;
        appData.currentRole = null;
        document.getElementById('loginScreen').style.display = 'flex';
        document.getElementById('appContainer').style.display = 'none';
        document.getElementById('password').value = '';
        document.getElementById('username').value = '';
    }
}

// Show app
function showApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appContainer').style.display = 'block';

    // Update header with user name
    const userName = appData.currentUser === 'admin' ? getNombreAdmin() : appData.currentUser;
    document.getElementById('appTitle').textContent = userName;

    buildNavigation();

    // Iniciar en dashboard si es admin/profesional, pacientes si es recepción
    const tabInicial = (appData.currentRole === 'admin' || appData.currentRole === 'professional')
        ? 'dashboard'
        : 'pacientes';
    showTab(tabInicial);
    updatePerfilTab();
}

// Build navigation
function buildNavigation() {
    let nav = '';
    const role = appData.currentRole;

    // Dashboard para Admin y Profesionales
    if (role === 'professional' || role === 'admin') {
        nav += `
            <button class="nav-item active" onclick="showTab('dashboard')">
                <svg fill="currentColor" viewBox="0 0 20 20"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"></path></svg>
                <span>Dashboard</span>
            </button>
        `;
    }

    // TODOS LOS ROLES ven Pacientes y Agenda
    nav += `
        <button class="nav-item ${role === 'reception' ? 'active' : ''}" onclick="showTab('pacientes')">
            <svg fill="currentColor" viewBox="0 0 20 20"><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"></path></svg>
            <span>Pacientes</span>
        </button>
        <button class="nav-item" onclick="showTab('agenda')">
            <svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd"></path></svg>
            <span>Agenda</span>
        </button>
    `;

    if (role === 'professional' || role === 'admin') {
        nav += `
            <button class="nav-item" onclick="showTab('factura')">
                <svg fill="currentColor" viewBox="0 0 20 20"><path d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"></path></svg>
                <span>Factura</span>
            </button>
            <button class="nav-item" onclick="showTab('ingresos')">
                <svg fill="currentColor" viewBox="0 0 20 20"><path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8 8.114 8 8c0-.114.07-.34.433-.582zM11 12.849v-1.698c.22.071.412.164.567.267.364.243.433.468.433.582 0 .114-.07.34-.433.582a2.305 2.305 0 01-.567.267z"></path><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6 7.009 6 8c0 .99.602 1.765 1.324 2.246.48.32 1.054.545 1.676.662v1.941c-.391-.127-.68-.317-.843-.504a1 1 0 10-1.51 1.31c.562.649 1.413 1.076 2.353 1.253V15a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 14 12.991 14 12c0-.99-.602-1.765-1.324-2.246A4.535 4.535 0 0011 9.092V7.151c.391.127.68.317.843.504a1 1 0 101.511-1.31c-.563-.649-1.413-1.076-2.354-1.253V5z" clip-rule="evenodd"></path></svg>
                <span>Ingresos</span>
            </button>
        `;
    }

    if (role === 'reception' || role === 'admin') {
        nav += `
            <button class="nav-item" onclick="showTab('cobrar')">
                <svg fill="currentColor" viewBox="0 0 20 20"><path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z"></path><path fill-rule="evenodd" d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z" clip-rule="evenodd"></path></svg>
                <span>Cobrar</span>
            </button>
            <button class="nav-item" onclick="showTab('cuadre')">
                <svg fill="currentColor" viewBox="0 0 20 20"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"></path></svg>
                <span>Cuadre</span>
            </button>
            <button class="nav-item" onclick="showTab('gastos')">
                <svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 2a4 4 0 00-4 4v1H5a1 1 0 00-.994.89l-1 9A1 1 0 004 18h12a1 1 0 00.994-1.11l-1-9A1 1 0 0015 7h-1V6a4 4 0 00-4-4zm2 5V6a2 2 0 10-4 0v1h4zm-6 3a1 1 0 112 0 1 1 0 01-2 0zm7-1a1 1 0 100 2 1 1 0 000-2z" clip-rule="evenodd"></path></svg>
                <span>Gastos</span>
            </button>
        `;
    }

    if (role === 'admin') {
        nav += `
            <button class="nav-item" onclick="showTab('personal')">
                <svg fill="currentColor" viewBox="0 0 20 20"><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"></path></svg>
                <span>Personal</span>
            </button>
        `;
    }

    // Lab accesible para todos (icono dental)
    nav += `
        <button class="nav-item" onclick="showTab('laboratorio')">
            <svg fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                <path d="M10 2c-1.5 0-2.7.5-3.6 1.5C5.5 4.5 5 6 5 8c0 1.2.3 2.3.7 3.3.4 1 1 2 1.6 2.9.6.9 1.2 1.7 1.7 2.4.5.7.9 1.2 1.1 1.6.1.2.2.3.2.3s.1-.1.2-.3c.2-.4.6-.9 1.1-1.6.5-.7 1.1-1.5 1.7-2.4.6-.9 1.2-1.9 1.6-2.9.4-1 .7-2.1.7-3.3 0-2-.5-3.5-1.4-4.5C12.7 2.5 11.5 2 10 2zm0 3c.6 0 1 .4 1 1v1h1c.6 0 1 .4 1 1s-.4 1-1 1h-1v1c0 .6-.4 1-1 1s-1-.4-1-1V9H8c-.6 0-1-.4-1-1s.4-1 1-1h1V6c0-.6.4-1 1-1z"/>
            </svg>
            <span>Lab</span>
        </button>
    `;

    nav += `
        <button class="nav-item" onclick="showTab('perfil')">
            <svg fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"></path></svg>
            <span>Perfil</span>
        </button>
    `;

    document.getElementById('bottomNav').innerHTML = nav;
}

// Show tab
function showTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const tab = document.getElementById(`tab-${tabName}`);
    if (tab) {
        tab.classList.add('active');
        const navButtons = Array.from(document.querySelectorAll('.nav-item'));
        const activeNav = navButtons.find(btn => btn.textContent.toLowerCase().includes(tabName));
        if (activeNav) activeNav.classList.add('active');

        if (tabName === 'factura') {
            // Mostrar selector de profesional solo si es admin
            const container = document.getElementById('selectorProfesionalFactura');
            if (container) {
                if (appData.currentRole === 'admin') {
                    container.style.display = 'block';
                    // Llenar dropdown con profesionales
                    const select = document.getElementById('profesionalQueAtendio');
                    const profesionales = appData.personal.filter(p => p.tipo !== 'empleado');
                    select.innerHTML = '<option value="">Seleccione el profesional...</option>' +
                        profesionales.map(p => `<option value="${p.nombre}">${p.nombre}</option>`).join('');
                } else {
                    container.style.display = 'none';
                }
            }
        }
        if (tabName === 'dashboard') updateDashboardTab();
        if (tabName === 'ingresos') updateIngresosTab();
        if (tabName === 'cobrar') updateCobrarTab();
        if (tabName === 'cuadre') updateCuadreTab();
        if (tabName === 'gastos') updateGastosTab();
        if (tabName === 'personal') updatePersonalTab();
        if (tabName === 'pacientes') updatePacientesTab();
        if (tabName === 'agenda') updateAgendaTab();
        if (tabName === 'laboratorio') updateLaboratorioTab();
    }
}

// Currency format
function formatCurrency(amount) {
    return 'RD$ ' + parseFloat(amount || 0).toLocaleString('es-DO', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

// Procedimientos
let tempProcedimientos = [];

function openAddProcedimiento() {
    document.getElementById('procDesc').value = '';
    document.getElementById('procCant').value = '1';
    document.getElementById('procPrecio').value = '';
    openModal('modalAddProcedimiento');
}

function agregarProcedimiento() {
    const desc = document.getElementById('procDesc').value;
    const cant = parseInt(document.getElementById('procCant').value);
    const precio = parseFloat(document.getElementById('procPrecio').value);

    if (!desc || !cant || !precio) {
        alert('Complete todos los campos');
        return;
    }

    // VALIDACIÓN: Precio no puede ser negativo
    if (precio < 0) {
        alert('❌ El precio no puede ser negativo');
        return;
    }

    // VALIDACIÓN: Cantidad debe ser positiva
    if (cant <= 0) {
        alert('❌ La cantidad debe ser mayor a 0');
        return;
    }

    tempProcedimientos.push({
        id: generateId(),
        descripcion: desc,
        cantidad: cant,
        precioUnitario: precio
    });

    updateProcedimientosList();
    closeModal('modalAddProcedimiento');
}

function updateProcedimientosList() {
    const list = document.getElementById('procedimientosList');
    if (tempProcedimientos.length === 0) {
        list.innerHTML = '<div style="color: #8e8e93; padding: 10px;">No hay procedimientos agregados</div>';
    } else {
        list.innerHTML = tempProcedimientos.map(p => `
            <div class="procedimiento-item">
                <div>
                    <div style="font-weight: 600;">${p.descripcion}</div>
                    <div style="font-size: 13px; color: #666;">${p.cantidad}x ${formatCurrency(p.precioUnitario)}</div>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <strong style="color: #002366;">${formatCurrency(p.cantidad * p.precioUnitario)}</strong>
                    <button class="procedimiento-delete" onclick="removeProcedimiento('${p.id}')">×</button>
                </div>
            </div>
        `).join('');
    }
    updateTotal();
}

function removeProcedimiento(id) {
    tempProcedimientos = tempProcedimientos.filter(p => p.id !== id);
    updateProcedimientosList();
}

function updateDescuento() {
    const val = document.getElementById('descuentoSlider').value;
    document.getElementById('descuentoValue').textContent = val;
    updateTotal();
}

function setDescuento(val) {
    document.getElementById('descuentoSlider').value = val;
    updateDescuento();
}

function updateTotal() {
    const subtotal = tempProcedimientos.reduce((sum, p) => sum + (p.cantidad * p.precioUnitario), 0);

    // Agregar precio de órdenes de laboratorio
    const totalLab = tempOrdenesLab.reduce((sum, o) => sum + o.precio, 0);
    const subtotalConLab = subtotal + totalLab;

    const descuento = parseFloat(document.getElementById('descuentoSlider').value) / 100;
    const total = subtotalConLab * (1 - descuento);
    document.getElementById('totalFactura').textContent = formatCurrency(total);
}

async function generarFactura() {
    const pacienteInput = document.getElementById('pacienteNombre');
    const paciente = pacienteInput.value;
    const notas = document.getElementById('notasFactura').value;

    if (!paciente) {
        alert('Complete el nombre del paciente');
        return;
    }

    // VALIDACIÓN ESTRICTA: El paciente debe haber sido seleccionado de la lista
    if (!pacienteInput.dataset.pacienteSeleccionado || pacienteInput.dataset.pacienteSeleccionado !== 'true') {
        alert('❌ Debe seleccionar el paciente de la lista de sugerencias.\n\nNo puede escribir el nombre libremente.');
        return;
    }

    if (tempProcedimientos.length === 0 && tempOrdenesLab.length === 0) {
        alert('Agregue al menos un procedimiento o una orden de laboratorio');
        return;
    }

    const subtotal = tempProcedimientos.reduce((sum, p) => sum + (p.cantidad * p.precioUnitario), 0);

    // Agregar precio de órdenes de laboratorio al subtotal
    const totalLab = tempOrdenesLab.reduce((sum, o) => sum + o.precio, 0);
    const subtotalConLab = subtotal + totalLab;

    const descuento = parseFloat(document.getElementById('descuentoSlider').value);
    const total = subtotalConLab * (1 - descuento / 100);

    // ========================================
    // DETERMINAR PROFESIONAL QUE ATENDIÓ
    // ========================================
    let profesionalQueAtendio = appData.currentUser;

    // Si es admin, DEBE seleccionar el profesional
    if (appData.currentRole === 'admin') {
        const profesionalSelect = document.getElementById('profesionalQueAtendio');
        if (!profesionalSelect.value) {
            alert('❌ Debe seleccionar el profesional que atendió al paciente');
            return;
        }
        profesionalQueAtendio = profesionalSelect.value;
    }

    // ========================================
    // BUSCAR CITA DEL DÍA PARA VINCULAR
    // ========================================
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const manana = new Date(hoy);
    manana.setDate(manana.getDate() + 1);

    const citaHoy = appData.citas.find(c => {
        const fechaCita = new Date(c.fecha);
        fechaCita.setHours(0, 0, 0, 0);

        return c.paciente === paciente &&
               fechaCita >= hoy &&
               fechaCita < manana &&
               c.profesional === profesionalQueAtendio &&
               c.estado !== 'Cancelada' &&
               c.estado !== 'Inasistencia';
    });

    // Número secuencial basado en facturas existentes
    const ultimoNumero = appData.facturas
        .map(f => parseInt(f.numero.replace('F-', '')) || 0)
        .reduce((max, n) => Math.max(max, n), 0);
    const nuevoNumero = String(ultimoNumero + 1).padStart(4, '0');

    const factura = {
        id: generateId(),
        numero: 'F-' + nuevoNumero,
        fecha: new Date().toISOString(),
        paciente,
        pacienteId: document.getElementById('pacienteNombre').dataset.pacienteId || null,
        procedimientos: [...tempProcedimientos],
        ordenesLab: [...tempOrdenesLab],
        subtotal: subtotalConLab,
        descuento,
        total,
        profesional: profesionalQueAtendio,
        estado: 'pendiente',
        pagos: [],
        notas,
        tieneOrdenesLab: tempOrdenesLab.length > 0,
        citaId: citaHoy ? citaHoy.id : null,
        citaHora: citaHoy ? citaHoy.hora : null,
        citaMotivo: citaHoy ? citaHoy.motivo : null
    };

    appData.facturas.push(factura);

    // Marcar cita como completada (SIN vincular a factura)
    if (citaHoy) {
        citaHoy.estado = 'Completada';
        citaHoy.fechaCompletada = new Date().toISOString();
        citaHoy.procedimientosRealizados = tempProcedimientos.map(p => p.nombre).join(', ');
    }

    // Crear órdenes de laboratorio vinculadas a esta factura
    await crearOrdenesLabDesdeFactura(factura);

    await saveData();

    const mensaje = citaHoy
        ? `✅ Factura generada exitosamente\n\n✔️ Vinculada con cita de las ${citaHoy.hora}\n✔️ Cita marcada como Completada`
        : '✅ Factura generada exitosamente';

    alert(mensaje + (tempOrdenesLab.length > 0 ? `\n\n🔬 ${tempOrdenesLab.length} orden(es) de laboratorio creadas` : ''));

    document.getElementById('pacienteNombre').value = '';
    document.getElementById('notasFactura').value = '';
    document.getElementById('descuentoSlider').value = '0';
    updateDescuento();
    tempProcedimientos = [];
    tempOrdenesLab = [];
    updateProcedimientosList();
    updateListaOrdenesLabTemp();
}

// Ingresos Tab
function updateIngresosTab() {
    const today = new Date().setHours(0,0,0,0);
    const misFacturas = appData.facturas.filter(f => f.profesional === appData.currentUser);

    const ingresosHoy = misFacturas
        .flatMap(f => f.pagos)
        .filter(p => new Date(p.fecha).setHours(0,0,0,0) === today)
        .reduce((sum, p) => sum + p.monto, 0);

    const prof = appData.personal.find(p => p.nombre === appData.currentUser);
    const comision = prof && prof.tipo !== 'empleado' && !prof.isAdmin ? getComisionRate(prof.tipo) : 0;
    const comisionesHoy = ingresosHoy * comision / 100;

    const lastPayment = prof?.lastPaymentDate ? new Date(prof.lastPaymentDate) : new Date(0);
    const comisionesAcum = misFacturas
        .filter(f => f.estado === 'pagada' && new Date(f.fecha) > lastPayment)
        .reduce((sum, f) => sum + (f.pagos.reduce((s, p) => s + p.monto, 0) * comision / 100), 0);

    const porCobrar = misFacturas
        .filter(f => f.estado !== 'pagada')
        .reduce((sum, f) => sum + (f.total - f.pagos.reduce((s, p) => s + p.monto, 0)), 0);

    document.getElementById('ingresosHoy').textContent = formatCurrency(ingresosHoy);
    document.getElementById('comisionesHoy').textContent = formatCurrency(comisionesHoy);
    document.getElementById('comisionesAcum').textContent = formatCurrency(comisionesAcum);
    document.getElementById('porCobrar').textContent = formatCurrency(porCobrar);

    const list = document.getElementById('facturasPersonal');
    if (misFacturas.length === 0) {
        list.innerHTML = '<li style="text-align: center; color: #8e8e93;">No hay facturas</li>';
    } else {
        list.innerHTML = misFacturas.map(f => `
            <li>
                <div class="item-header">
                    <div>
                        <div style="font-size: 12px; color: #8e8e93;">${f.numero}</div>
                        <div class="item-title">${f.paciente}</div>
                    </div>
                    <span class="badge badge-${f.estado === 'pagada' ? 'paid' : f.estado === 'partial' ? 'partial' : 'pending'}">
                        ${f.estado === 'pagada' ? 'Pagada' : f.estado === 'partial' ? 'Con Abono' : 'Pendiente'}
                    </span>
                </div>
                <div class="item-amount">${formatCurrency(f.total)}</div>
            </li>
        `).join('');
    }
}

function getComisionRate(tipo) {
    return tipo === 'regular' ? 60 : tipo === 'especialista' ? 50 : 0;
}

// Cobrar Tab
function updateCobrarTab() {
    const today = new Date().setHours(0,0,0,0);
    const cobradoHoy = appData.facturas
        .flatMap(f => f.pagos)
        .filter(p => new Date(p.fecha).setHours(0,0,0,0) === today)
        .reduce((sum, p) => sum + p.monto, 0);

    document.getElementById('cobradoHoy').textContent = formatCurrency(cobradoHoy);

    // Aplicar filtros (que también actualiza el contador de pendientes)
    aplicarFiltrosFacturas();
}

let currentFacturaToPay = null;
let tipoPagoSeleccionado = 'total';
let currentFacturaCliente = '';

function selectTipoPago(tipo) {
    tipoPagoSeleccionado = tipo;

    const btnTotal = document.getElementById('btnPagoTotal');
    const btnAbono = document.getElementById('btnPagoAbono');
    const montoInput = document.getElementById('pagoMonto');

    if (tipo === 'total') {
        btnTotal.style.background = '#002366';
        btnTotal.style.color = 'white';
        btnAbono.style.background = '#f0f0f0';
        btnAbono.style.color = '#333';

        if (currentFacturaToPay) {
            const balance = currentFacturaToPay.total - currentFacturaToPay.pagos.reduce((sum, p) => sum + p.monto, 0);
            montoInput.value = balance.toFixed(2);
        }
    } else {
        btnAbono.style.background = '#002366';
        btnAbono.style.color = 'white';
        btnTotal.style.background = '#f0f0f0';
        btnTotal.style.color = '#333';

        montoInput.value = '';
    }

    actualizarNuevoBalance();
}

function actualizarNuevoBalance() {
    if (!currentFacturaToPay) return;

    const monto = parseFloat(document.getElementById('pagoMonto').value) || 0;
    const balanceActual = currentFacturaToPay.total - currentFacturaToPay.pagos.reduce((sum, p) => sum + p.monto, 0);
    const nuevoBalance = balanceActual - monto;

    document.getElementById('nuevoBalance').textContent = formatCurrency(nuevoBalance);
    document.getElementById('nuevoBalance').style.color = nuevoBalance <= 0 ? '#34c759' : '#ff3b30';
}

function openPagarFactura(facturaId) {
    const factura = appData.facturas.find(f => f.id === facturaId);
    if (!factura) return;

    currentFacturaToPay = factura;
    tipoPagoSeleccionado = 'total';

    const balance = factura.total - factura.pagos.reduce((sum, p) => sum + p.monto, 0);

    // Mostrar nombre real en vez de "admin"
    const nombreProfesional = factura.profesional.toLowerCase() === 'admin' ? getNombreAdmin() : factura.profesional;

    document.getElementById('pagoFacturaNum').textContent = factura.numero;
    document.getElementById('pagoPaciente').textContent = factura.paciente;
    document.getElementById('pagoProfesional').textContent = nombreProfesional;
    document.getElementById('pagoTotal').textContent = formatCurrency(factura.total);
    document.getElementById('pagoBalance').textContent = formatCurrency(balance);
    document.getElementById('pagoMonto').value = balance.toFixed(2);
    document.getElementById('pagoMetodo').value = 'efectivo';
    document.getElementById('comprobanteSection').classList.add('hidden');
    document.getElementById('comprobantePreview').classList.add('hidden');

    selectTipoPago('total');

    openModal('modalPagarFactura');
}

document.getElementById('pagoMonto').addEventListener('input', actualizarNuevoBalance);

document.getElementById('pagoMetodo').addEventListener('change', function() {
    if (this.value === 'transferencia') {
        document.getElementById('comprobanteSection').classList.remove('hidden');
    } else {
        document.getElementById('comprobanteSection').classList.add('hidden');
    }
});

document.getElementById('comprobanteFile').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById('comprobantePreview').src = e.target.result;
            document.getElementById('comprobantePreview').classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    }
});

function confirmarPago() {
    const monto = parseFloat(document.getElementById('pagoMonto').value);
    const metodo = document.getElementById('pagoMetodo').value;

    if (!monto || monto <= 0) {
        alert('Ingrese un monto válido');
        return;
    }

    // Validar que el monto no supere el balance pendiente
    const totalPagadoActual = currentFacturaToPay.pagos.reduce((sum, p) => sum + p.monto, 0);
    const balancePendiente = currentFacturaToPay.total - totalPagadoActual;

    if (monto > balancePendiente + 0.01) { // +0.01 para tolerancia de decimales
        alert(`❌ El monto ingresado (${formatCurrency(monto)}) supera el balance pendiente (${formatCurrency(balancePendiente)}).\n\nNo se puede cobrar más de lo que se debe.`);
        return;
    }

    const pago = {
        id: generateId(),
        monto,
        metodo,
        fecha: new Date().toISOString(),
        comprobanteData: null
    };

    if (metodo === 'transferencia') {
        const preview = document.getElementById('comprobantePreview');
        if (preview.src && !preview.classList.contains('hidden')) {
            pago.comprobanteData = preview.src;
        }
    }

    currentFacturaToPay.pagos.push(pago);

    const totalPagado = currentFacturaToPay.pagos.reduce((sum, p) => sum + p.monto, 0);
    if (totalPagado >= currentFacturaToPay.total) {
        currentFacturaToPay.estado = 'pagada';
    } else if (totalPagado > 0) {
        currentFacturaToPay.estado = 'partial';
    }

    saveData();

    // Generar factura para cliente
    generarFacturaCliente(currentFacturaToPay, monto, metodo);

    updateCobrarTab();
    closeModal('modalPagarFactura');
}

function generarFacturaCliente(factura, montoPagado, metodoPago) {
    const fecha = new Date().toLocaleDateString('es-DO', {year: 'numeric', month: 'long', day: 'numeric'});
    const hora = new Date().toLocaleTimeString('es-DO', {hour: '2-digit', minute: '2-digit'});
    const balance = factura.total - factura.pagos.reduce((sum, p) => sum + p.monto, 0);
    const esPagoTotal = balance <= 0;

    // Mostrar nombre real en vez de "admin"
    const nombreProfesional = factura.profesional.toLowerCase() === 'admin' ? getNombreAdmin() : factura.profesional;

    let facturaHTML = `
        <div style="text-align: center; margin-bottom: 25px;">
            <img src="logo-factura.png" alt="Logo Clínica Dental" style="max-width: 280px; margin-bottom: 15px;">
            <div style="color: #666; font-size: 13px; margin-top: 10px;">
                <div>Calle Altagracia #14, Nagua</div>
                <div>Tel: 809-584-3647 | WhatsApp: 829-649-3647</div>
            </div>
            <div style="color: #888; font-size: 11px; font-style: italic; margin-top: 8px; max-width: 400px; margin-left: auto; margin-right: auto;">
                3 generaciones ofreciendo un servicio personalizado y de calidad a nuestros pacientes desde 1966
            </div>
        </div>

        <div style="border-top: 3px solid #002366; border-bottom: 3px solid #002366; padding: 15px 0; margin: 20px 0;">
            <div style="text-align: center;">
                <h3 style="color: #002366; margin: 0; font-size: 20px;">${esPagoTotal ? 'RECIBO DE PAGO' : 'COMPROBANTE DE ABONO'}</h3>
                <div style="color: #666; font-size: 13px; margin-top: 5px;">Factura: ${factura.numero}</div>
            </div>
        </div>

        <div style="margin: 20px 0;">
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <tr>
                    <td style="padding: 8px 0; color: #666; width: 40%;">Fecha:</td>
                    <td style="padding: 8px 0; font-weight: 600;">${fecha} - ${hora}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666;">Paciente:</td>
                    <td style="padding: 8px 0; font-weight: 600;">${factura.paciente}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #666;">Atendido por:</td>
                    <td style="padding: 8px 0; font-weight: 600;">${nombreProfesional}</td>
                </tr>
            </table>
        </div>

        <div style="border-top: 2px solid #e0e0e0; margin: 20px 0;"></div>

        <div style="margin: 20px 0;">
            <h4 style="color: #002366; margin-bottom: 10px;">Detalle del Tratamiento:</h4>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                    <tr style="background: #f5f5f5;">
                        <th style="padding: 8px; text-align: left; color: #002366;">Descripción</th>
                        <th style="padding: 8px; text-align: center; color: #002366;">Cant.</th>
                        <th style="padding: 8px; text-align: right; color: #002366;">Precio</th>
                        <th style="padding: 8px; text-align: right; color: #002366;">Total</th>
                    </tr>
                </thead>
                <tbody>
    `;

    factura.procedimientos.forEach(proc => {
        facturaHTML += `
                    <tr style="border-bottom: 1px solid #e0e0e0;">
                        <td style="padding: 8px;">${proc.descripcion}</td>
                        <td style="padding: 8px; text-align: center;">${proc.cantidad}</td>
                        <td style="padding: 8px; text-align: right;">${formatCurrency(proc.precioUnitario)}</td>
                        <td style="padding: 8px; text-align: right; font-weight: 600;">${formatCurrency(proc.cantidad * proc.precioUnitario)}</td>
                    </tr>
        `;
    });

    // AGREGAR ÓRDENES DE LABORATORIO AL RECIBO
    if (factura.ordenesLab && factura.ordenesLab.length > 0) {
        factura.ordenesLab.forEach(orden => {
            facturaHTML += `
                    <tr style="border-bottom: 1px solid #e0e0e0; background: #f0f8ff;">
                        <td style="padding: 8px;">🔬 ${orden.tipo}${orden.dientes ? ` (Dientes: ${orden.dientes})` : ''}</td>
                        <td style="padding: 8px; text-align: center;">1</td>
                        <td style="padding: 8px; text-align: right;">${formatCurrency(orden.precio)}</td>
                        <td style="padding: 8px; text-align: right; font-weight: 600;">${formatCurrency(orden.precio)}</td>
                    </tr>
            `;
        });
    }

    facturaHTML += `
                </tbody>
            </table>
        </div>

        <div style="margin: 20px 0; padding: 15px; background: #f8f8f8; border-radius: 8px;">
            <table style="width: 100%; font-size: 14px;">
                <tr>
                    <td style="padding: 5px 0; color: #666;">Subtotal:</td>
                    <td style="padding: 5px 0; text-align: right; font-weight: 600;">${formatCurrency(factura.subtotal)}</td>
                </tr>
    `;

    if (factura.descuento > 0) {
        facturaHTML += `
                <tr>
                    <td style="padding: 5px 0; color: #666;">Descuento (${factura.descuento}%):</td>
                    <td style="padding: 5px 0; text-align: right; color: #ff3b30; font-weight: 600;">-${formatCurrency(factura.subtotal * factura.descuento / 100)}</td>
                </tr>
        `;
    }

    facturaHTML += `
                <tr style="border-top: 2px solid #002366;">
                    <td style="padding: 10px 0; color: #002366; font-size: 16px; font-weight: 700;">TOTAL DEL TRATAMIENTO:</td>
                    <td style="padding: 10px 0; text-align: right; color: #002366; font-size: 18px; font-weight: 700;">${formatCurrency(factura.total)}</td>
                </tr>
            </table>
        </div>

        <div style="margin: 20px 0; padding: 15px; background: #e8f5e9; border-radius: 8px; border-left: 4px solid #34c759;">
            <table style="width: 100%; font-size: 14px;">
                <tr>
                    <td style="padding: 5px 0; color: #2e7d32; font-weight: 600;">Pago Recibido:</td>
                    <td style="padding: 5px 0; text-align: right; color: #2e7d32; font-weight: 700; font-size: 16px;">${formatCurrency(montoPagado)}</td>
                </tr>
                <tr>
                    <td style="padding: 5px 0; color: #666;">Método de Pago:</td>
                    <td style="padding: 5px 0; text-align: right; font-weight: 600;">${metodoPago.charAt(0).toUpperCase() + metodoPago.slice(1)}</td>
                </tr>
            </table>
        </div>
    `;

    if (!esPagoTotal) {
        facturaHTML += `
        <div style="margin: 20px 0; padding: 15px; background: #fff3e0; border-radius: 8px; border-left: 4px solid #ff9500;">
            <table style="width: 100%; font-size: 14px;">
                <tr>
                    <td style="padding: 5px 0; color: #e65100; font-weight: 600;">Balance Pendiente:</td>
                    <td style="padding: 5px 0; text-align: right; color: #e65100; font-weight: 700; font-size: 16px;">${formatCurrency(balance)}</td>
                </tr>
            </table>
        </div>
        `;
    } else {
        facturaHTML += `
        <div style="margin: 20px 0; padding: 15px; background: #e8f5e9; border-radius: 8px; text-align: center;">
            <div style="color: #2e7d32; font-weight: 700; font-size: 16px;">✓ PAGADO EN SU TOTALIDAD</div>
        </div>
        `;
    }

    if (factura.notas) {
        facturaHTML += `
        <div style="margin: 20px 0; padding: 10px; background: #f5f5f5; border-radius: 8px;">
            <div style="color: #666; font-size: 12px; font-weight: 600; margin-bottom: 5px;">Notas:</div>
            <div style="color: #333; font-size: 13px;">${factura.notas}</div>
        </div>
        `;
    }

    facturaHTML += `
        <div style="border-top: 2px solid #e0e0e0; margin-top: 30px; padding-top: 20px; text-align: center;">
            <div style="color: #002366; font-weight: 600; font-size: 16px; margin-bottom: 10px;">
                ¡Gracias por preferirnos!
            </div>
            <div style="color: #888; font-size: 13px;">
                Vuelve pronto
            </div>
            <div style="color: #ccc; font-size: 11px; margin-top: 15px;">
                Recibo generado el ${fecha} a las ${hora}
            </div>
        </div>
    `;

    currentFacturaCliente = facturaHTML;
    document.getElementById('facturaClienteContent').innerHTML = facturaHTML;

    closeModal('modalPagarFactura');
    openModal('modalFacturaCliente');
}

function descargarFacturaImagen() {
    const elemento = document.getElementById('facturaClienteContent');
    const mensajeDiv = document.getElementById('mensajeDescarga');

    // Verificar que html2canvas está disponible
    if (typeof html2canvas === 'undefined') {
        mensajeDiv.style.display = 'block';
        mensajeDiv.style.background = '#ffebee';
        mensajeDiv.style.color = '#c62828';
        mensajeDiv.innerHTML = '❌ Error: Librería no cargada. Por favor, recarga la página.';
        return;
    }

    // Mostrar mensaje de espera
    mensajeDiv.style.display = 'block';
    mensajeDiv.style.background = '#e3f2fd';
    mensajeDiv.style.color = '#1976d2';
    mensajeDiv.innerHTML = '⏳ Generando imagen de la factura...';

    // Pequeño delay para asegurar que el DOM está listo
    setTimeout(() => {
        html2canvas(elemento, {
            scale: 2,
            backgroundColor: '#ffffff',
            logging: false,
            allowTaint: false,
            useCORS: true,
            imageTimeout: 0
        }).then(canvas => {
            canvas.toBlob(blob => {
                const fecha = new Date().toISOString().slice(0,10);
                const factura = currentFacturaToPay ? currentFacturaToPay.numero : 'factura';
                const nombreArchivo = `${factura}_${fecha}.png`;

                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = nombreArchivo;

                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);

                mensajeDiv.style.background = '#e8f5e9';
                mensajeDiv.style.color = '#2e7d32';
                mensajeDiv.innerHTML = `
                    ✅ <strong>¡Factura descargada!</strong><br>
                    <span style="font-size: 13px;">Ahora puedes compartirla por WhatsApp desde tu galería de fotos</span>
                `;

                setTimeout(() => {
                    mensajeDiv.style.display = 'none';
                }, 5000);
            }, 'image/png');
        }).catch(error => {
            console.error('Error al generar imagen:', error);
            mensajeDiv.style.background = '#ffebee';
            mensajeDiv.style.color = '#c62828';
            mensajeDiv.innerHTML = '❌ Error al generar la imagen. Por favor, intenta de nuevo.';

            setTimeout(() => {
                mensajeDiv.style.display = 'none';
            }, 5000);
        });
    }, 300);
}

function compartirFacturaWhatsApp() {
    // Esta función ya no se usa, pero la dejamos por si acaso
    const texto = document.getElementById('facturaClienteContent').innerText;
    const textoLimpio = texto.replace(/\s+/g, ' ').trim();
    window.open(`https://wa.me/?text=${encodeURIComponent(textoLimpio)}`, '_blank');
}

function imprimirFactura() {
    const ventana = window.open('', '', 'height=600,width=800');
    ventana.document.write('<html><head><title>Factura</title>');
    ventana.document.write('<style>body{font-family: Arial, sans-serif; padding: 20px;}</style>');
    ventana.document.write('</head><body>');
    ventana.document.write(document.getElementById('facturaClienteContent').innerHTML);
    ventana.document.write('</body></html>');
    ventana.document.close();
    ventana.print();
}

function copiarFactura() {
    const texto = document.getElementById('facturaClienteContent').innerText;
    navigator.clipboard.writeText(texto).then(() => {
        alert('Factura copiada al portapapeles');
    });
}

function verComprobante(comprobanteData) {
    document.getElementById('comprobanteDisplay').src = comprobanteData;
    openModal('modalVerComprobante');
}

function verComprobantesFactura(facturaId) {
    const factura = appData.facturas.find(f => f.id === facturaId);
    if (!factura) return;

    const comprobantesConData = factura.pagos.filter(p => p.comprobanteData);
    if (comprobantesConData.length > 0) {
        // Mostrar el primer comprobante (puedes mejorar esto para mostrar todos)
        verComprobante(comprobantesConData[0].comprobanteData);
    }
}

// Cuadre Tab
function updateCuadreTab() {
    const today = new Date().setHours(0,0,0,0);
    const todayDate = new Date().toLocaleDateString('es-DO', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'});
    document.getElementById('fechaCuadre').textContent = todayDate;

    const pagosHoy = appData.facturas
        .flatMap(f => f.pagos)
        .filter(p => new Date(p.fecha).setHours(0,0,0,0) === today);

    const efectivoHoy = pagosHoy.filter(p => p.metodo === 'efectivo').reduce((sum, p) => sum + p.monto, 0);
    const tarjetaHoy = pagosHoy.filter(p => p.metodo === 'tarjeta').reduce((sum, p) => sum + p.monto, 0);
    const transferenciaHoy = pagosHoy.filter(p => p.metodo === 'transferencia').reduce((sum, p) => sum + p.monto, 0);
    const totalIngresos = efectivoHoy + tarjetaHoy + transferenciaHoy;

    const gastosHoy = appData.gastos
        .filter(g => new Date(g.fecha).setHours(0,0,0,0) === today)
        .reduce((sum, g) => sum + g.monto, 0);

    const gastosEfectivoHoy = appData.gastos
        .filter(g => new Date(g.fecha).setHours(0,0,0,0) === today && g.metodo === 'efectivo')
        .reduce((sum, g) => sum + g.monto, 0);

    const balance = totalIngresos - gastosHoy;

    // EFECTIVO EN CAJA = Inicial + Ingresos efectivo - Gastos efectivo
    const efectivoInicial = parseFloat(document.getElementById('efectivoInicial').value) || 0;
    const efectivoCaja = efectivoInicial + efectivoHoy - gastosEfectivoHoy;

    document.getElementById('efectivoHoy').textContent = formatCurrency(efectivoHoy);
    document.getElementById('tarjetaHoy').textContent = formatCurrency(tarjetaHoy);
    document.getElementById('transferenciaHoy').textContent = formatCurrency(transferenciaHoy);
    document.getElementById('totalIngresosHoy').textContent = formatCurrency(totalIngresos);
    document.getElementById('gastosHoy').textContent = formatCurrency(gastosHoy);
    document.getElementById('gastosEfectivoHoy').textContent = formatCurrency(gastosEfectivoHoy);
    document.getElementById('balanceDia').textContent = formatCurrency(balance);
    document.getElementById('balanceDia').style.color = balance >= 0 ? '#34c759' : '#ff3b30';
    document.getElementById('efectivoCaja').textContent = formatCurrency(efectivoCaja);

    // Guardar cuadre del día actual (solo si hay actividad)
    if (totalIngresos > 0 || gastosHoy > 0) {
        guardarCuadreDiario(today, {
            fecha: new Date(today).toISOString(),
            efectivoInicial: efectivoInicial,
            efectivo: efectivoHoy,
            tarjeta: tarjetaHoy,
            transferencia: transferenciaHoy,
            totalIngresos: totalIngresos,
            gastos: gastosHoy,
            gastosEfectivo: gastosEfectivoHoy,
            balance: balance,
            efectivoCaja: efectivoCaja
        });
    }

    // Mostrar historial solo para admin
    if (appData.currentRole === 'admin') {
        document.getElementById('historialCuadres').style.display = 'block';
        mostrarHistorialCuadres();
    }

    // RENDERIZAR DETALLE DE TRANSACCIONES
    if (totalIngresos > 0 || gastosHoy > 0) {
        document.getElementById('detalleTransacciones').style.display = 'block';

        // Obtener facturas con pagos de hoy para vincular
        const facturasConPagosHoy = appData.facturas
            .map(f => {
                const pagosDeHoy = f.pagos.filter(p => new Date(p.fecha).setHours(0,0,0,0) === today);
                return pagosDeHoy.length > 0 ? { ...f, pagosDeHoy } : null;
            })
            .filter(f => f !== null);

        // Lista de ingresos
        let htmlIngresos = '';
        facturasConPagosHoy.forEach(f => {
            f.pagosDeHoy.forEach(p => {
                const hora = new Date(p.fecha).toLocaleTimeString('es-DO', {hour: '2-digit', minute: '2-digit'});
                const icono = p.metodo === 'efectivo' ? '💵' : p.metodo === 'tarjeta' ? '💳' : '🔄';
                htmlIngresos += `
                    <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e0e0e0;">
                        <div>
                            <span style="font-weight: 600;">${icono} ${f.paciente}</span>
                            <span style="color: #666; font-size: 12px; margin-left: 8px;">${hora}</span>
                            <div style="font-size: 12px; color: #999;">Factura ${f.numero} - ${p.metodo}</div>
                        </div>
                        <div style="font-weight: 600; color: #34c759;">${formatCurrency(p.monto)}</div>
                    </div>
                `;
            });
        });

        if (htmlIngresos === '') {
            htmlIngresos = '<div style="color: #999; text-align: center; padding: 10px;">No hay ingresos registrados hoy</div>';
        }
        document.getElementById('listaIngresos').innerHTML = htmlIngresos;

        // Lista de gastos
        const gastosDeHoy = appData.gastos.filter(g => new Date(g.fecha).setHours(0,0,0,0) === today);
        let htmlGastos = '';
        gastosDeHoy.forEach(g => {
            const hora = new Date(g.fecha).toLocaleTimeString('es-DO', {hour: '2-digit', minute: '2-digit'});
            const icono = g.metodo === 'efectivo' ? '💵' : g.metodo === 'tarjeta' ? '💳' : '🔄';
            htmlGastos += `
                <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e0e0e0;">
                    <div>
                        <span style="font-weight: 600;">${icono} ${g.descripcion}</span>
                        <span style="color: #666; font-size: 12px; margin-left: 8px;">${hora}</span>
                        ${g.proveedor ? `<div style="font-size: 12px; color: #999;">Proveedor: ${g.proveedor}</div>` : ''}
                        <div style="font-size: 12px; color: #999;">${g.metodo}</div>
                    </div>
                    <div style="font-weight: 600; color: #ff3b30;">${formatCurrency(g.monto)}</div>
                </div>
            `;
        });

        if (htmlGastos === '') {
            htmlGastos = '<div style="color: #999; text-align: center; padding: 10px;">No hay gastos registrados hoy</div>';
        }
        document.getElementById('listaGastos').innerHTML = htmlGastos;
    } else {
        document.getElementById('detalleTransacciones').style.display = 'none';
    }
}

// Guardar cuadre diario (solo llamar manualmente, no en onSnapshot)
function guardarCuadreDiario(fechaTimestamp, cuadre) {
    if (!appData.cuadresDiarios) {
        appData.cuadresDiarios = {};
    }
    // Solo guardar si el valor cambió realmente
    const existente = appData.cuadresDiarios[fechaTimestamp];
    if (existente &&
        existente.totalIngresos === cuadre.totalIngresos &&
        existente.gastos === cuadre.gastos &&
        existente.efectivoInicial === cuadre.efectivoInicial) {
        return; // Sin cambios, no guardar
    }
    appData.cuadresDiarios[fechaTimestamp] = cuadre;
    saveData();
}

// Mostrar historial de última semana
function mostrarHistorialCuadres() {
    const hoy = new Date().setHours(0,0,0,0);
    const hace7Dias = hoy - (7 * 24 * 60 * 60 * 1000);

    if (!appData.cuadresDiarios) {
        document.getElementById('historialCuadresList').innerHTML = '<li style="text-align: center; color: #8e8e93;">No hay historial disponible</li>';
        return;
    }

    const cuadres = Object.entries(appData.cuadresDiarios)
        .filter(([timestamp]) => parseInt(timestamp) >= hace7Dias && parseInt(timestamp) < hoy)
        .sort(([a], [b]) => parseInt(b) - parseInt(a)); // Más reciente primero

    if (cuadres.length === 0) {
        document.getElementById('historialCuadresList').innerHTML = '<li style="text-align: center; color: #8e8e93;">No hay cuadres de la última semana</li>';
        return;
    }

    const list = cuadres.map(([timestamp, cuadre]) => {
        const fecha = new Date(parseInt(timestamp));
        const fechaStr = fecha.toLocaleDateString('es-DO', {weekday: 'short', day: 'numeric', month: 'short'});

        return `
            <li>
                <div style="margin-bottom: 10px;">
                    <strong style="color: #002366;">${fechaStr}</strong>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 13px;">
                    <div>Ingresos: <strong style="color: #34c759;">${formatCurrency(cuadre.totalIngresos)}</strong></div>
                    <div>Gastos: <strong style="color: #ff3b30;">${formatCurrency(cuadre.gastos)}</strong></div>
                    <div>Balance: <strong style="color: ${cuadre.balance >= 0 ? '#34c759' : '#ff3b30'};">${formatCurrency(cuadre.balance)}</strong></div>
                    <div>En caja: <strong style="color: #002366;">${formatCurrency(cuadre.efectivoCaja)}</strong></div>
                </div>
            </li>
        `;
    }).join('');

    document.getElementById('historialCuadresList').innerHTML = list;
}

// Gastos
function openAddGasto() {
    document.getElementById('gastoDesc').value = '';
    document.getElementById('gastoMonto').value = '';
    document.getElementById('gastoProveedor').value = '';
    document.getElementById('gastoMetodo').value = 'efectivo';
    document.getElementById('gastoPreview').classList.add('hidden');
    openModal('modalAddGasto');
}

document.getElementById('gastoFile').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById('gastoPreview').src = e.target.result;
            document.getElementById('gastoPreview').classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    }
});

function registrarGasto() {
    const desc = document.getElementById('gastoDesc').value;
    const monto = parseFloat(document.getElementById('gastoMonto').value);
    const proveedor = document.getElementById('gastoProveedor').value;
    const metodo = document.getElementById('gastoMetodo').value;

    if (!desc || !monto || !proveedor) {
        alert('Complete todos los campos obligatorios');
        return;
    }

    const preview = document.getElementById('gastoPreview');
    const facturaData = preview.src && !preview.classList.contains('hidden') ? preview.src : null;

    const gasto = {
        id: generateId(),
        fecha: new Date().toISOString(),
        descripcion: desc,
        monto,
        proveedor,
        metodo,
        registradoPor: appData.currentUser,
        facturaData,
        aprobado: true
    };

    appData.gastos.push(gasto);
    saveData();
    updateGastosTab();
    closeModal('modalAddGasto');
    alert('Gasto registrado exitosamente');
}

function updateGastosTab() {
    const list = document.getElementById('gastosList');
    if (appData.gastos.length === 0) {
        list.innerHTML = '<li style="text-align: center; color: #8e8e93;">No hay gastos registrados</li>';
    } else {
        list.innerHTML = appData.gastos.map(g => `
            <li>
                <div class="item-header">
                    <div class="item-title">${g.descripcion}</div>
                    <div class="item-amount" style="color: #ff3b30;">${formatCurrency(g.monto)}</div>
                </div>
                <div class="item-meta">
                    ${g.proveedor} • ${g.metodo.charAt(0).toUpperCase() + g.metodo.slice(1)} • ${new Date(g.fecha).toLocaleDateString('es-DO')}
                </div>
                ${g.facturaData ? `
                    <button class="btn btn-secondary" style="margin-top: 10px; padding: 8px 16px; font-size: 13px;" onclick="verComprobante('${g.facturaData}')">
                        📎 Ver Factura
                    </button>
                ` : ''}
                ${appData.currentRole === 'admin' ? `
                    <button class="btn btn-danger" style="margin-top: 10px; padding: 8px 16px; font-size: 13px;" onclick="eliminarGasto('${g.id}')">Eliminar</button>
                ` : ''}
            </li>
        `).join('');
    }
}

function eliminarGasto(id) {
    const gasto = appData.gastos.find(g => g.id === id);
    if (!gasto) return;

    if (confirm(`🗑️ ¿Eliminar gasto?\n\n${gasto.descripcion}\nMonto: ${formatCurrency(gasto.monto)}\n${gasto.proveedor ? `Proveedor: ${gasto.proveedor}\n` : ''}\nEsta acción no se puede deshacer.`)) {
        appData.gastos = appData.gastos.filter(g => g.id !== id);
        saveData();
        updateGastosTab();
    }
}

// Personal
function openAddPersonal() {
    document.getElementById('personalNombre').value = '';
    document.getElementById('personalTipo').value = 'regular';
    document.getElementById('personalSueldo').value = '';
    document.getElementById('personalPassword').value = '';
    document.getElementById('sueldoGroup').classList.add('hidden');
    document.getElementById('passwordGroup').classList.remove('hidden');
    openModal('modalAddPersonal');
}

function toggleSueldo() {
    const tipo = document.getElementById('personalTipo').value;
    const exequaturGroup = document.getElementById('exequaturGroup');
    const sueldoGroup = document.getElementById('sueldoGroup');
    const passwordGroup = document.getElementById('passwordGroup');

    if (tipo === 'empleado') {
        sueldoGroup.classList.remove('hidden');
        passwordGroup.classList.add('hidden');
        exequaturGroup.classList.add('hidden'); // Empleados no necesitan exequatur
    } else {
        sueldoGroup.classList.add('hidden');
        passwordGroup.classList.remove('hidden');
        exequaturGroup.classList.remove('hidden'); // Profesionales sí necesitan exequatur
    }
}

function agregarPersonal() {
    const nombre = document.getElementById('personalNombre').value;
    const tipo = document.getElementById('personalTipo').value;
    const sueldo = parseFloat(document.getElementById('personalSueldo').value);
    const password = document.getElementById('personalPassword').value;
    const exequatur = document.getElementById('personalExequatur').value.trim();

    if (!nombre || (tipo === 'empleado' && !sueldo)) {
        alert('Complete todos los campos obligatorios');
        return;
    }

    const person = {
        id: generateId(),
        nombre,
        tipo,
        exequatur: tipo !== 'empleado' ? exequatur : null, // Solo profesionales tienen exequatur
        sueldo: tipo === 'empleado' ? sueldo : null,
        password: tipo !== 'empleado' && password ? password : (tipo === 'empleado' ? 'empleado123' : null),
        canAccessReception: tipo === 'empleado' ? false : false,
        nextPayDate: tipo === 'empleado' ? null : null
    };

    appData.personal.push(person);
    saveData();
    updatePersonalTab();
    updateProfessionalPicker();
    closeModal('modalAddPersonal');
    alert('Personal agregado exitosamente');
}

function updatePersonalTab() {
    const list = document.getElementById('personalList');
    const personal = appData.personal.filter(p => !p.isAdmin);

    if (personal.length === 0) {
        list.innerHTML = '<li style="text-align: center; color: #8e8e93;">No hay personal registrado</li>';
    } else {
        list.innerHTML = personal.map(p => {
            const comisionRate = getComisionRate(p.tipo);
            const comisionesAcum = p.tipo !== 'empleado' ? calcularComisionesAcumuladas(p) : 0;
            const totalAvances = calcularTotalAvances(p.id);

            return `
                <li onclick="openPersonalDetail('${p.id}')">
                    <div class="item-header">
                        <div>
                            <div class="item-title">${p.nombre}</div>
                            <div class="item-meta">${getTipoLabel(p.tipo)}</div>
                        </div>
                        <div style="text-align: right;">
                            ${p.tipo !== 'empleado' ? `
                                <div style="font-size: 18px; font-weight: 700; color: #002366;">${comisionRate}%</div>
                                ${comisionesAcum > 0 ? `<div style="font-size: 13px; color: #ff9500;">${formatCurrency(comisionesAcum)}</div>` : ''}
                            ` : `
                                <div style="font-size: 18px; font-weight: 700; color: #34c759;">${formatCurrency(p.sueldo)}</div>
                                ${totalAvances > 0 ? `<div style="font-size: 13px; color: #8e44ad;">Avances: ${formatCurrency(totalAvances)}</div>` : ''}
                            `}
                        </div>
                    </div>
                </li>
            `;
        }).join('');
    }
}

function getTipoLabel(tipo) {
    const labels = {
        'regular': 'Odontólogo Regular',
        'especialista': 'Especialista',
        'empleado': 'Empleado'
    };
    return labels[tipo] || tipo;
}

function calcularComisionesAcumuladas(person) {
    const lastPayment = person.lastPaymentDate ? new Date(person.lastPaymentDate) : new Date(0);
    const comisionRate = getComisionRate(person.tipo);

    // Calcular comisiones sobre el TOTAL COBRADO de facturas pagadas
    // (el total ya incluye laboratorio, no hay que contarlo aparte)
    const comisiones = appData.facturas
        .filter(f => f.profesional === person.nombre && f.estado === 'pagada' && new Date(f.fecha) > lastPayment)
        .reduce((sum, f) => sum + (f.pagos.reduce((s, p) => s + p.monto, 0) * comisionRate / 100), 0);

    return comisiones;
}

function calcularTotalAvances(personalId) {
    return appData.avances
        .filter(a => a.personalId === personalId)
        .reduce((sum, a) => sum + a.monto, 0);
}

let currentPersonalDetail = null;

function openPersonalDetail(id) {
    const person = appData.personal.find(p => p.id === id);
    if (!person) return;

    // Registrar acceso a información sensible
    if (person.tipo === 'empleado') {
        registrarAuditoria(
            'acceso',
            'dato_sensible',
            `Consultó información salarial de ${person.nombre} (${getTipoLabel(person.tipo)})`
        );
    }

    currentPersonalDetail = person;
    document.getElementById('personalDetailName').textContent = person.nombre;

    let content = `
        <div style="margin-bottom: 20px;">
            <div style="color: #666; font-size: 14px;">Tipo</div>
            <div style="font-weight: 600; font-size: 16px;">${getTipoLabel(person.tipo)}</div>
        </div>
    `;

    if (person.tipo !== 'empleado') {
        const comisionRate = getComisionRate(person.tipo);
        const comisionesAcum = calcularComisionesAcumuladas(person);

        content += `
            <div style="margin-bottom: 20px;">
                <div style="color: #666; font-size: 14px;">Comisión</div>
                <div style="font-weight: 700; font-size: 18px; color: #002366;">${comisionRate}%</div>
            </div>
            <div style="margin-bottom: 20px;">
                <div style="color: #666; font-size: 14px;">Comisiones Acumuladas</div>
                <div style="font-weight: 700; font-size: 24px; color: #ff9500;">${formatCurrency(comisionesAcum)}</div>
            </div>
        `;

        // Siempre mostrar botón de pago para profesionales (aunque sea 0)
        content += `
            <button class="btn btn-submit" style="background: #34c759; margin-bottom: 15px; width: 100%;" onclick="event.stopPropagation(); confirmarPagoProfesional('${person.id}')">
                💰 Pagar Comisiones
            </button>
        `;
    } else {
        const totalAvances = calcularTotalAvances(person.id);
        const avances = appData.avances.filter(a => a.personalId === person.id).slice(0, 5);
        const nextPayDate = person.nextPayDate ? new Date(person.nextPayDate).toLocaleDateString('es-DO') : 'No establecida';

        content += `
            <div style="margin-bottom: 20px;">
                <div style="color: #666; font-size: 14px;">Sueldo Mensual</div>
                <div style="font-weight: 700; font-size: 18px; color: #34c759;">${formatCurrency(person.sueldo)}</div>
            </div>
            <div style="margin-bottom: 20px;">
                <div style="color: #666; font-size: 14px;">Total Avances</div>
                <div style="font-weight: 700; font-size: 24px; color: #8e44ad;">${formatCurrency(totalAvances)}</div>
            </div>
            <div style="margin-bottom: 20px;">
                <div style="color: #666; font-size: 14px;">Próxima Fecha de Pago</div>
                <div style="font-weight: 600; font-size: 16px;">${nextPayDate}</div>
            </div>
            <button class="btn btn-submit" style="background: #34c759; margin-bottom: 15px; width: 100%;" onclick="event.stopPropagation(); confirmarPagoEmpleado('${person.id}')">
                💰 Pagar Salario
            </button>
            <button class="btn btn-add" style="width: 100%;" onclick="event.stopPropagation(); openAvance('${person.id}')">+ Registrar Avance</button>
            ${avances.length > 0 ? `
                <div style="margin-top: 20px;">
                    <h3 style="font-size: 16px; margin-bottom: 10px;">Últimos Avances</h3>
                    ${avances.map(a => `
                        <div style="padding: 10px; background: #f8f8f8; border-radius: 8px; margin-bottom: 8px;">
                            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                                <strong>${formatCurrency(a.monto)}</strong>
                                <span style="color: #8e8e93; font-size: 13px;">${new Date(a.fecha).toLocaleDateString('es-DO')}</span>
                            </div>
                            ${a.notas ? `<div style="font-size: 13px; color: #666;">${a.notas}</div>` : ''}
                        </div>
                    `).join('')}
                </div>
            ` : ''}
        `;
    }

    content += `
        <button class="btn btn-secondary" style="width: 100%; margin-top: 15px;" onclick="event.stopPropagation(); openEditPersonal('${person.id}')">
            ✏️ Editar Perfil
        </button>
        <button class="btn btn-danger" style="width: 100%; margin-top: 10px;" onclick="event.stopPropagation(); eliminarPersonal('${person.id}')">
            Eliminar Personal
        </button>
    `;

    document.getElementById('personalDetailContent').innerHTML = content;
    openModal('modalPersonalDetail');
}

function confirmarPagoProfesional(id) {
    const person = appData.personal.find(p => p.id === id);
    if (!person) return;

    const comisionesAcum = calcularComisionesAcumuladas(person);

    // Contar facturas que generaron la comisión
    const lastPayment = person.lastPaymentDate ? new Date(person.lastPaymentDate) : new Date(0);
    const facturasPagadas = appData.facturas.filter(f =>
        f.profesional === person.nombre &&
        f.estado === 'pagada' &&
        new Date(f.fecha) > lastPayment
    );

    mostrarConfirmacion({
        titulo: '💰 Pagar Comisiones',
        mensaje: `
            <div style="background: linear-gradient(135deg, #34c759 0%, #30d158 100%); padding: 20px; border-radius: 8px; color: white; margin-bottom: 15px; text-align: center;">
                <div style="font-size: 14px; opacity: 0.9; margin-bottom: 8px;">Comisiones a Pagar</div>
                <div style="font-size: 36px; font-weight: 700;">${formatCurrency(comisionesAcum)}</div>
            </div>
            <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                <div style="font-size: 16px; font-weight: 600; color: #002366; margin-bottom: 8px;">
                    ${person.nombre}
                </div>
                <div style="font-size: 14px; color: #666; margin-bottom: 4px;">
                    <strong>Cargo:</strong> ${getTipoLabel(person.tipo)}
                </div>
                <div style="font-size: 14px; color: #666; margin-bottom: 4px;">
                    <strong>Tasa de Comisión:</strong> ${getComisionRate(person.tipo)}%
                </div>
                <div style="font-size: 14px; color: #666;">
                    <strong>Facturas cobradas:</strong> ${facturasPagadas.length}
                </div>
            </div>
            <div style="background: #e3f2fd; padding: 12px; border-radius: 6px; font-size: 13px; color: #0d47a1; text-align: center;">
                ℹ️ Se generará un recibo imprimible
            </div>
        `,
        tipo: 'normal',
        confirmText: 'Sí, Pagar Ahora',
        onConfirm: () => {
            // Generar recibo
            const fecha = new Date().toLocaleDateString('es-DO', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'});
            const hora = new Date().toLocaleTimeString('es-DO');

            let recibo = `
================================
${getNombreClinica()}
${getNombreAdmin()}
================================

RECIBO DE PAGO DE COMISIONES

Fecha: ${fecha}
Hora: ${hora}
Para: ${person.nombre}
Cargo: ${getTipoLabel(person.tipo)}
Comisión: ${getComisionRate(person.tipo)}%

================================
COMISIONES PAGADAS
================================

Monto: ${formatCurrency(comisionesAcum)}

================================

Registrado por: ${appData.currentUser}

Firma: _____________________

¡Gracias por su excelente trabajo!

================================
            `;

            // Resetear comisiones
            person.lastPaymentDate = new Date().toISOString();

            currentReciboText = recibo;
            document.getElementById('reciboContent').textContent = recibo;

            saveData();
            closeModal('modalPersonalDetail');
            openModal('modalRecibo');

            // Actualizar la lista
            setTimeout(() => {
                updatePersonalTab();
            }, 100);
        }
    });
}

function confirmarPagoEmpleado(id) {
    const person = appData.personal.find(p => p.id === id);
    if (!person) return;

    const totalAvances = calcularTotalAvances(person.id);
    const neto = person.sueldo - totalAvances;

    if (!confirm(`¿Confirmar pago de salario de ${formatCurrency(person.sueldo)} para ${person.nombre}?\n\nAvances: ${formatCurrency(totalAvances)}\nPago Neto: ${formatCurrency(neto)}`)) {
        return;
    }

    // Generar recibo
    const fecha = new Date().toLocaleDateString('es-DO', {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'});
    const hora = new Date().toLocaleTimeString('es-DO');

    let recibo = `
================================
${getNombreClinica()}
${getNombreAdmin()}
================================

RECIBO DE PAGO DE SALARIO

Fecha: ${fecha}
Hora: ${hora}
Para: ${person.nombre}
Cargo: ${getTipoLabel(person.tipo)}

================================
DETALLE DEL PAGO
================================

Salario Base:        ${formatCurrency(person.sueldo)}
`;

    if (totalAvances > 0) {
        recibo += `Avances Descontados: ${formatCurrency(totalAvances)}\n`;
        recibo += `--------------------------------\n`;
        recibo += `PAGO NETO:           ${formatCurrency(neto)}\n`;
    } else {
        recibo += `--------------------------------\n`;
        recibo += `PAGO TOTAL:          ${formatCurrency(person.sueldo)}\n`;
    }

    recibo += `
================================

Registrado por: ${appData.currentUser}

Firma: _____________________

¡Gracias por su dedicación!

================================
    `;

    // Resetear avances
    appData.avances = appData.avances.filter(a => a.personalId !== person.id);

    currentReciboText = recibo;
    document.getElementById('reciboContent').textContent = recibo;

    saveData();
    closeModal('modalPersonalDetail');
    openModal('modalRecibo');

    // Actualizar la lista
    setTimeout(() => {
        updatePersonalTab();
    }, 100);
}

function compartirWhatsApp() {
    const texto = encodeURIComponent(currentReciboText);
    window.open(`https://wa.me/?text=${texto}`, '_blank');
}

function copiarRecibo() {
    navigator.clipboard.writeText(currentReciboText).then(() => {
        alert('Recibo copiado al portapapeles');
    });
}

function openEditPersonal(id) {
    const person = appData.personal.find(p => p.id === id);
    if (!person) return;

    currentPersonalToEdit = person;

    document.getElementById('editNombre').value = person.nombre;
    document.getElementById('editPassword').value = '';

    // Password field always visible for admin
    document.getElementById('editPasswordGroup').classList.remove('hidden');

    if (person.tipo === 'empleado') {
        document.getElementById('editSueldoGroup').classList.remove('hidden');
        document.getElementById('editSueldo').value = person.sueldo || '';
        document.getElementById('editReceptionGroup').classList.remove('hidden');
        document.getElementById('editReceptionAccess').checked = person.canAccessReception || false;
        document.getElementById('editPayDateGroup').classList.remove('hidden');
        document.getElementById('editPayDate').value = person.nextPayDate ? new Date(person.nextPayDate).toISOString().split('T')[0] : '';
    } else {
        document.getElementById('editSueldoGroup').classList.add('hidden');
        document.getElementById('editReceptionGroup').classList.add('hidden');
        document.getElementById('editPayDateGroup').classList.add('hidden');
    }

    closeModal('modalPersonalDetail');
    openModal('modalEditPersonal');
}

function guardarEdicion() {
    if (!currentPersonalToEdit) return;

    const nombre = document.getElementById('editNombre').value;
    const password = document.getElementById('editPassword').value;

    if (!nombre) {
        alert('El nombre es obligatorio');
        return;
    }

    currentPersonalToEdit.nombre = nombre;

    // Update password for ANY user if provided
    if (password) {
        currentPersonalToEdit.password = password;
    }

    if (currentPersonalToEdit.tipo === 'empleado') {
        const sueldo = parseFloat(document.getElementById('editSueldo').value);
        if (sueldo) currentPersonalToEdit.sueldo = sueldo;
        currentPersonalToEdit.canAccessReception = document.getElementById('editReceptionAccess').checked;
        const payDate = document.getElementById('editPayDate').value;
        if (payDate) currentPersonalToEdit.nextPayDate = new Date(payDate).toISOString();
    }

    saveData();
    updatePersonalTab();
    updateProfessionalPicker();
    closeModal('modalEditPersonal');
    alert('Perfil actualizado exitosamente');
}

function openAvance(personalId) {
    currentPersonalDetail = appData.personal.find(p => p.id === personalId);
    document.getElementById('avanceMonto').value = '';
    document.getElementById('avanceNotas').value = '';
    closeModal('modalPersonalDetail');
    openModal('modalAvance');
}

function registrarAvance() {
    const monto = parseFloat(document.getElementById('avanceMonto').value);
    const notas = document.getElementById('avanceNotas').value;

    if (!monto || monto <= 0) {
        alert('Ingrese un monto válido');
        return;
    }

    // Validar que el avance no supere el sueldo disponible
    if (currentPersonalDetail.tipo === 'empleado' && currentPersonalDetail.sueldo) {
        const avancesActuales = calcularTotalAvances(currentPersonalDetail.id);
        const disponible = currentPersonalDetail.sueldo - avancesActuales;

        if (monto > disponible) {
            alert(`❌ El avance (${formatCurrency(monto)}) supera el sueldo disponible.\n\nSueldo: ${formatCurrency(currentPersonalDetail.sueldo)}\nAvances previos: ${formatCurrency(avancesActuales)}\nDisponible: ${formatCurrency(disponible)}`);
            return;
        }
    }

    const avance = {
        id: generateId(),
        personalId: currentPersonalDetail.id,
        monto,
        notas,
        fecha: new Date().toISOString(),
        registradoPor: appData.currentUser
    };

    appData.avances.push(avance);
    saveData();
    closeModal('modalAvance');
    updatePersonalTab();
    alert('Avance registrado exitosamente');
}

function eliminarPersonal(id) {
    const person = appData.personal.find(p => p.id === id);
    if (!person) return;

    // Prevenir auto-eliminación de admin
    if (person.isAdmin) {
        alert('❌ No se puede eliminar la cuenta de administrador.');
        return;
    }

    // Verificar si tiene facturas asociadas
    const facturasAsociadas = appData.facturas.filter(f => f.profesional === person.nombre);
    const avancesAsociados = appData.avances.filter(a => a.personalId === id);
    const comisionesAcumuladas = calcularComisionesAcumuladas(person);

    let advertencias = '';
    if (facturasAsociadas.length > 0) {
        advertencias += `<div style="background: #fff3cd; padding: 10px; border-radius: 6px; margin-bottom: 10px; border-left: 3px solid #ffc107;">
            <div style="color: #856404; font-size: 13px;">
                ⚠️ Tiene <strong>${facturasAsociadas.length} factura(s)</strong> registrada(s).
                <br>Los registros históricos se conservarán.
            </div>
        </div>`;
    }
    if (avancesAsociados.length > 0) {
        const totalAvances = avancesAsociados.reduce((sum, a) => sum + a.monto, 0);
        advertencias += `<div style="background: #ffe6e6; padding: 10px; border-radius: 6px; margin-bottom: 10px; border-left: 3px solid #ff3b30;">
            <div style="color: #c41e3a; font-size: 13px;">
                ⚠️ Tiene <strong>${avancesAsociados.length} avance(s)</strong> pendiente(s) por ${formatCurrency(totalAvances)}.
                <br>Los avances serán eliminados.
            </div>
        </div>`;
    }
    if (comisionesAcumuladas > 0) {
        advertencias += `<div style="background: #fff3cd; padding: 10px; border-radius: 6px; margin-bottom: 10px; border-left: 3px solid #ffc107;">
            <div style="color: #856404; font-size: 13px;">
                ⚠️ Tiene comisiones acumuladas de <strong>${formatCurrency(comisionesAcumuladas)}</strong> sin pagar.
            </div>
        </div>`;
    }

    mostrarConfirmacion({
        titulo: `⚠️ Eliminar Personal`,
        mensaje: `
            <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                <div style="font-size: 18px; font-weight: 600; color: #002366; margin-bottom: 8px;">
                    ${person.nombre}
                </div>
                <div style="font-size: 14px; color: #666;">
                    <strong>Tipo:</strong> ${getTipoLabel(person.tipo)}
                </div>
            </div>
            ${advertencias}
            <div style="background: #f8f9fa; padding: 12px; border-radius: 6px; color: #666; font-size: 13px; text-align: center;">
                Esta acción no se puede deshacer
            </div>
        `,
        tipo: 'peligro',
        confirmText: 'Sí, Eliminar Personal',
        onConfirm: () => {
            appData.personal = appData.personal.filter(p => p.id !== id);
            // Limpiar avances huérfanos
            appData.avances = appData.avances.filter(a => a.personalId !== id);
            saveData();
            closeModal('modalPersonalDetail');
            closeModal('modalEditPersonal');
            updatePersonalTab();
            updateProfessionalPicker();
        }
    });
}

// Perfil Tab
function updatePerfilTab() {
    document.getElementById('perfilNombre').textContent = appData.currentUser;
    const roles = {
        'professional': 'Profesional',
        'reception': 'Recepción',
        'admin': 'Administrador'
    };
    document.getElementById('perfilRol').textContent = roles[appData.currentRole];

    // Mostrar botón de auditoría solo para admin
    const btnAuditoria = document.getElementById('btnAuditoria');
    if (btnAuditoria) {
        btnAuditoria.style.display = appData.currentRole === 'admin' ? 'block' : 'none';
    }

    // Mostrar configuración de zona horaria solo para admin
    const timezoneCard = document.getElementById('timezoneCard');
    if (timezoneCard) {
        if (appData.currentRole === 'admin') {
            timezoneCard.style.display = 'block';

            // Establecer zona horaria actual
            const currentTimezone = getTimezone();
            const timezoneSelect = document.getElementById('timezoneSelect');
            if (timezoneSelect) {
                timezoneSelect.value = currentTimezone;
            }
        } else {
            timezoneCard.style.display = 'none';
        }
    }

    // Mostrar importar pacientes solo para admin
    const importarCard = document.getElementById('importarCard');
    if (importarCard) {
        importarCard.style.display = appData.currentRole === 'admin' ? 'block' : 'none';
    }

    // Mostrar reversiones solo para admin
    const reversionesCard = document.getElementById('reversionesCard');
    if (appData.currentRole === 'admin') {
        reversionesCard.style.display = 'block';

        const list = document.getElementById('reversionesList');
        const reversiones = appData.reversiones || [];

        if (reversiones.length === 0) {
            list.innerHTML = '<li style="text-align: center; color: #8e8e93;">No hay reversiones registradas</li>';
        } else {
            // Mostrar más recientes primero
            list.innerHTML = reversiones.sort((a, b) => new Date(b.fecha) - new Date(a.fecha)).map(r => `
                <li>
                    <div class="item-header">
                        <div class="item-title">Factura ${r.facturaNumero} - ${r.paciente}</div>
                        <div style="color: #ff3b30; font-weight: 700;">${formatCurrency(r.montoReversado)}</div>
                    </div>
                    <div class="item-meta">
                        ${formatDateWithTimezone(r.fecha)} • ${r.metodoPago} • Por: ${r.reversadoPor}
                    </div>
                    <div style="margin-top: 8px; padding: 10px; background: #fff3cd; border-radius: 6px; font-size: 13px; color: #856404;">
                        <strong>Motivo:</strong> ${r.motivo}
                    </div>
                </li>
            `).join('');
        }
    } else {
        reversionesCard.style.display = 'none';
    }
}

// Modal
function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

// Close modal on outside click
document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', function(e) {
        if (e.target === this) {
            this.classList.remove('active');
        }
    });
});

// ========================================
// ELIMINAR FACTURA (SOLO ADMIN)
// ========================================

function eliminarFactura(facturaId) {
    const factura = appData.facturas.find(f => f.id === facturaId);
    if (!factura) return;

    if (appData.currentRole !== 'admin') {
        alert('Solo el administrador puede eliminar facturas');
        return;
    }

    const totalPagado = factura.pagos.reduce((sum, p) => sum + p.monto, 0);
    const estadoLabel = factura.estado === 'pagada' ? 'Pagada' :
                       factura.estado === 'partial' ? 'Con abono' : 'Pendiente';

    mostrarConfirmacion({
        titulo: '⚠️ Eliminar Factura',
        mensaje: `
            <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                <div style="font-size: 18px; font-weight: 600; color: #002366; margin-bottom: 10px;">
                    Factura ${factura.numero}
                </div>
                <div style="font-size: 14px; color: #666; margin-bottom: 5px;">
                    <strong>Paciente:</strong> ${factura.paciente}
                </div>
                <div style="font-size: 14px; color: #666; margin-bottom: 5px;">
                    <strong>Profesional:</strong> ${factura.profesional}
                </div>
                <div style="font-size: 14px; color: #666; margin-bottom: 5px;">
                    <strong>Total:</strong> ${formatCurrency(factura.total)}
                </div>
                <div style="font-size: 14px; color: #666; margin-bottom: 5px;">
                    <strong>Pagado:</strong> ${formatCurrency(totalPagado)}
                </div>
                <div style="font-size: 14px; color: #666;">
                    <strong>Estado:</strong> ${estadoLabel}
                </div>
            </div>
            <div style="background: #fff3cd; padding: 12px; border-radius: 6px; border-left: 3px solid #ffc107;">
                <strong style="color: #856404;">⚠️ Esta acción NO se puede deshacer.</strong>
            </div>
        `,
        tipo: 'peligro',
        confirmText: 'Sí, Eliminar Factura',
        onConfirm: () => {
            // Registrar auditoría ANTES de eliminar
            registrarAuditoria(
                'eliminar',
                'factura',
                `Factura ${factura.numero} - Paciente: ${factura.paciente} - Total: ${formatCurrency(factura.total)}`
            );

            appData.facturas = appData.facturas.filter(f => f.id !== facturaId);
            saveData();
            updateCobrarTab();
            alert('✅ Factura eliminada correctamente');
        }
    });
}

// ========================================
// REVERSAR COBRO
// ========================================

function abrirReversarCobro(facturaId) {
    // Solo admin puede reversar cobros
    if (appData.currentRole !== 'admin') {
        alert('❌ Solo el administrador puede reversar cobros.');
        return;
    }

    const factura = appData.facturas.find(f => f.id === facturaId);
    if (!factura || factura.pagos.length === 0) {
        alert('No hay pagos para reversar');
        return;
    }

    currentFacturaToReverse = factura;
    const ultimoPago = factura.pagos[factura.pagos.length - 1];

    document.getElementById('reversarFacturaNum').textContent = factura.numero;
    document.getElementById('reversarPaciente').textContent = factura.paciente;
    document.getElementById('reversarMonto').textContent = formatCurrency(ultimoPago.monto);
    document.getElementById('reversarMotivo').value = '';

    openModal('modalReversarCobro');
}

function confirmarReversion() {
    const motivo = document.getElementById('reversarMotivo').value.trim();

    if (!motivo) {
        alert('Por favor ingresa el motivo de la reversión');
        return;
    }

    if (!currentFacturaToReverse) return;

    const factura = appData.facturas.find(f => f.id === currentFacturaToReverse.id);
    if (!factura || factura.pagos.length === 0) return;

    // Remover último pago
    const pagoReversado = factura.pagos.pop();

    // Recalcular estado de la factura
    const totalPagado = factura.pagos.reduce((sum, p) => sum + p.monto, 0);
    if (totalPagado === 0) {
        factura.estado = 'pendiente';
    } else if (totalPagado < factura.total) {
        factura.estado = 'partial';
    } else {
        factura.estado = 'pagada';
    }

    // Registrar la reversión
    const reversion = {
        id: generateId(),
        facturaId: factura.id,
        facturaNumero: factura.numero,
        paciente: factura.paciente,
        montoReversado: pagoReversado.monto,
        metodoPago: pagoReversado.metodo,
        motivo: motivo,
        reversadoPor: appData.currentUser,
        fecha: new Date().toISOString(),
        pagoOriginal: pagoReversado
    };

    appData.reversiones.push(reversion);

    // Guardar cambios
    saveData();
    updateCobrarTab();
    closeModal('modalReversarCobro');

    alert(`✅ Pago reversado correctamente\n\nMonto: ${formatCurrency(pagoReversado.monto)}\n\nEl registro quedará en el historial de admin.`);
}

// ========================================
// UTILIDADES
// ========================================

function formatDate(dateString) {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString('es-DO', {year: 'numeric', month: 'long', day: 'numeric'});
}

function generateId(prefix = '') {
    return prefix + Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

// ========================================
// MÓDULO DE PACIENTES
// ========================================

let currentPacienteId = null;

function updatePacientesTab() {
    const lista = document.getElementById('listaPacientes');
    if (!lista) return;

    if (appData.pacientes.length === 0) {
        lista.innerHTML = '<div style="text-align: center; padding: 60px; color: #999;"><div style="font-size: 48px; margin-bottom: 16px;">👥</div><div style="font-size: 16px;">No hay pacientes registrados</div></div>';
        return;
    }

    lista.innerHTML = appData.pacientes.map(p => {
        const balance = calcularBalancePaciente(p.nombre);
        const facturasPaciente = appData.facturas.filter(f => f.paciente === p.nombre);

        return `
            <div class="list-item" onclick="verPaciente('${p.id}')" style="cursor: pointer; padding: 20px; margin-bottom: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <div style="font-size: 18px; font-weight: 600; color: #002366;">${p.nombre}</div>
                    <div>
                        ${balance > 0 ? `<span class="badge badge-warning">${formatCurrency(balance)}</span>` :
                          balance === 0 && facturasPaciente.length > 0 ? `<span class="badge badge-success">Al día</span>` : ''}
                    </div>
                </div>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px;">
                    ${p.telefono ? `<div style="font-size: 14px; color: #666;">📞 ${p.telefono}</div>` : ''}
                    ${p.cedula ? `<div style="font-size: 14px; color: #666;">🆔 ${p.cedula}</div>` : ''}
                    ${p.email ? `<div style="font-size: 14px; color: #666;">✉️ ${p.email}</div>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function filterPacientes() {
    const search = document.getElementById('searchPacientes').value.toLowerCase();
    const items = document.querySelectorAll('#listaPacientes .list-item');
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(search) ? 'block' : 'none';
    });
}

function abrirModalNuevoPaciente() {
    document.getElementById('nuevoPacienteNombre').value = '';
    document.getElementById('nuevoPacienteCedula').value = '';
    document.getElementById('nuevoPacienteTelefono').value = '';
    document.getElementById('nuevoPacienteEmail').value = '';
    openModal('modalNuevoPaciente');
}

async function guardarPaciente() {
    const nombre = document.getElementById('nuevoPacienteNombre').value.trim();
    const telefono = document.getElementById('nuevoPacienteTelefono').value.trim();

    if (!nombre || !telefono) {
        alert('Nombre y teléfono son obligatorios');
        return;
    }

    const paciente = {
        id: generateId('PAC-'),
        nombre,
        cedula: document.getElementById('nuevoPacienteCedula').value.trim(),
        telefono,
        email: document.getElementById('nuevoPacienteEmail').value.trim(),
        fechaNacimiento: document.getElementById('nuevoPacienteFechaNacimiento').value,
        sexo: document.getElementById('nuevoPacienteSexo').value,
        grupoSanguineo: document.getElementById('nuevoPacienteGrupoSanguineo').value,
        direccion: document.getElementById('nuevoPacienteDireccion').value.trim(),
        alergias: document.getElementById('nuevoPacienteAlergias').value.trim(),
        seguroMedico: document.getElementById('nuevoPacienteSeguro').value.trim(),
        contactoEmergencia: {
            nombre: document.getElementById('nuevoPacienteEmergenciaNombre').value.trim(),
            telefono: document.getElementById('nuevoPacienteEmergenciaTelefono').value.trim()
        },
        condiciones: document.getElementById('nuevoPacienteCondiciones').value.trim(),
        fechaRegistro: new Date().toISOString()
    };

    appData.pacientes.push(paciente);
    await saveData();
    closeModal('modalNuevoPaciente');
    updatePacientesTab();

    // Limpiar formulario
    document.getElementById('nuevoPacienteNombre').value = '';
    document.getElementById('nuevoPacienteCedula').value = '';
    document.getElementById('nuevoPacienteTelefono').value = '';
    document.getElementById('nuevoPacienteEmail').value = '';
    document.getElementById('nuevoPacienteFechaNacimiento').value = '';
    document.getElementById('nuevoPacienteSexo').value = '';
    document.getElementById('nuevoPacienteGrupoSanguineo').value = '';
    document.getElementById('nuevoPacienteDireccion').value = '';
    document.getElementById('nuevoPacienteAlergias').value = '';
    document.getElementById('nuevoPacienteSeguro').value = '';
    document.getElementById('nuevoPacienteEmergenciaNombre').value = '';
    document.getElementById('nuevoPacienteEmergenciaTelefono').value = '';
    document.getElementById('nuevoPacienteCondiciones').value = '';
}

function verPaciente(pacienteId) {
    currentPacienteId = pacienteId;
    const paciente = appData.pacientes.find(p => p.id === pacienteId);
    if (!paciente) return;

    document.getElementById('verPacienteNombre').textContent = paciente.nombre;

    // Subtítulo con info rápida
    let subtitulo = paciente.cedula || '';
    if (paciente.telefono) subtitulo += subtitulo ? ` • ${paciente.telefono}` : paciente.telefono;
    document.getElementById('verPacienteSubtitulo').textContent = subtitulo;

    // Renderizar tabs
    renderTabResumen(paciente);
    renderTabBalance(paciente);
    renderTabHistorial(paciente);
    renderTabRecetas(paciente);
    renderTabDocumentos(paciente);
    
    // Ocultar tab Balance para profesionales (solo admin y recepción pueden cobrar)
    const tabBalanceBtn = document.getElementById('tabBalanceBtn');
    if (tabBalanceBtn) {
        if (appData.currentRole === 'professional') {
            tabBalanceBtn.style.display = 'none';
        } else {
            tabBalanceBtn.style.display = 'block';
        }
    }

    // Activar primer tab
    cambiarTabPaciente('resumen');

    openModal('modalVerPaciente');
}

function cambiarTabPaciente(tabName) {
    // Actualizar botones
    document.querySelectorAll('.paciente-tab').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

    // Actualizar contenido
    document.querySelectorAll('.paciente-tab-content').forEach(content => {
        content.style.display = 'none';
    });

    const tabMap = {
        'resumen': 'tabResumen',
        'balance': 'tabBalance',
        'historial': 'tabHistorial',
        'recetas': 'tabRecetas',
        'documentos': 'tabDocumentos'
    };

    document.getElementById(tabMap[tabName]).style.display = 'block';
}

function renderTabResumen(paciente) {
    // Calcular edad
    let edad = '';
    if (paciente.fechaNacimiento) {
        const hoy = new Date();
        const nac = new Date(paciente.fechaNacimiento);
        let edadAnos = hoy.getFullYear() - nac.getFullYear();
        const mes = hoy.getMonth() - nac.getMonth();
        if (mes < 0 || (mes === 0 && hoy.getDate() < nac.getDate())) {
            edadAnos--;
        }
        edad = edadAnos + ' años';
    }

    // Calcular balance usando helper robusto
    const facturasPaciente = getFacturasDePaciente(paciente);
    const balance = calcularBalancePaciente(paciente.nombre);

    // Estadísticas usando helpers
    const totalCitas = getCitasDePaciente(paciente).length;
    const totalRecetas = (paciente.recetas || []).length;
    const totalPlacas = (paciente.placas || []).length;

    document.getElementById('tabResumen').innerHTML = `
        <!-- Tarjetas de estadísticas -->
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 12px; color: white;">
                <div style="font-size: 32px; font-weight: 700; margin-bottom: 4px;">${totalCitas}</div>
                <div style="font-size: 13px; opacity: 0.9;">Citas</div>
            </div>
            <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 20px; border-radius: 12px; color: white;">
                <div style="font-size: 32px; font-weight: 700; margin-bottom: 4px;">${totalRecetas}</div>
                <div style="font-size: 13px; opacity: 0.9;">Recetas</div>
            </div>
            <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); padding: 20px; border-radius: 12px; color: white;">
                <div style="font-size: 32px; font-weight: 700; margin-bottom: 4px;">${totalPlacas}</div>
                <div style="font-size: 13px; opacity: 0.9;">Placas</div>
            </div>
            <div style="background: linear-gradient(135deg, ${balance > 0 ? '#fa709a 0%, #fee140' : '#30cfd0 0%, #330867'} 100%); padding: 20px; border-radius: 12px; color: white;">
                <div style="font-size: 24px; font-weight: 700; margin-bottom: 4px;">${formatCurrency(balance)}</div>
                <div style="font-size: 13px; opacity: 0.9;">Balance</div>
            </div>
        </div>

        <!-- Información del paciente -->
        <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 24px;">
            <h3 style="font-size: 16px; color: #002366; margin-bottom: 16px; font-weight: 700;">Información Personal</h3>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;">
                <div>
                    <div style="font-size: 11px; color: #666; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Cédula</div>
                    <div style="font-size: 14px; font-weight: 500;">${paciente.cedula || 'No registrada'}</div>
                </div>
                <div>
                    <div style="font-size: 11px; color: #666; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Teléfono</div>
                    <div style="font-size: 14px; font-weight: 500;">${paciente.telefono || 'No registrado'}</div>
                </div>
                <div>
                    <div style="font-size: 11px; color: #666; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Email</div>
                    <div style="font-size: 14px; font-weight: 500;">${paciente.email || 'No registrado'}</div>
                </div>
                <div>
                    <div style="font-size: 11px; color: #666; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Edad</div>
                    <div style="font-size: 14px; font-weight: 500;">${edad || 'No registrada'}</div>
                </div>
                <div>
                    <div style="font-size: 11px; color: #666; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Sexo</div>
                    <div style="font-size: 14px; font-weight: 500;">${paciente.sexo || 'No registrado'}</div>
                </div>
                <div>
                    <div style="font-size: 11px; color: #666; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Grupo Sanguíneo</div>
                    <div style="font-size: 14px; font-weight: 500;">${paciente.grupoSanguineo || 'Desconocido'}</div>
                </div>
                ${paciente.direccion ? `
                <div style="grid-column: span 3;">
                    <div style="font-size: 11px; color: #666; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Dirección</div>
                    <div style="font-size: 14px; font-weight: 500;">${paciente.direccion}</div>
                </div>
                ` : ''}
                ${paciente.seguroMedico ? `
                <div style="grid-column: span 3;">
                    <div style="font-size: 11px; color: #666; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Seguro Médico</div>
                    <div style="font-size: 14px; font-weight: 500;">${paciente.seguroMedico}</div>
                </div>
                ` : ''}
                ${paciente.contactoEmergencia && paciente.contactoEmergencia.nombre ? `
                <div style="grid-column: span 3;">
                    <div style="font-size: 11px; color: #666; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Contacto de Emergencia</div>
                    <div style="font-size: 14px; font-weight: 500;">${paciente.contactoEmergencia.nombre} - ${paciente.contactoEmergencia.telefono}</div>
                </div>
                ` : ''}
            </div>

            ${paciente.alergias ? `
                <div style="background: #ffe5e5; padding: 12px; border-radius: 8px; margin-top: 16px; border-left: 3px solid #dc3545;">
                    <div style="font-size: 11px; color: #721c24; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">🚨 ALERGIAS</div>
                    <div style="font-size: 14px; font-weight: 500; color: #721c24;">${paciente.alergias}</div>
                </div>
            ` : ''}

            ${paciente.condiciones ? `
                <div style="background: #fff3cd; padding: 12px; border-radius: 8px; margin-top: 16px; border-left: 3px solid #ffc107;">
                    <div style="font-size: 11px; color: #856404; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">⚠️ Condiciones Médicas</div>
                    <div style="font-size: 14px; font-weight: 500; color: #1d1d1f;">${paciente.condiciones}</div>
                </div>
            ` : ''}
        </div>

        <!-- Próxima cita -->
        ${(() => {
            const citasFuturas = getCitasDePaciente(paciente)
                .filter(c => new Date(c.fecha) >= new Date())
                .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

            if (citasFuturas.length > 0) {
                const proxima = citasFuturas[0];
                return `
                    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; padding: 20px; color: white; margin-bottom: 24px;">
                        <h3 style="font-size: 16px; margin-bottom: 12px; font-weight: 700;">📅 Próxima Cita</h3>
                        <div style="font-size: 20px; font-weight: 600; margin-bottom: 4px;">${formatDate(proxima.fecha)} a las ${proxima.hora}</div>
                        <div style="font-size: 14px; opacity: 0.9;">${proxima.motivo}</div>
                        <div style="font-size: 13px; opacity: 0.8; margin-top: 4px;">Con ${proxima.profesional}</div>
                    </div>
                `;
            }
            return '';
        })()}

        <!-- Última receta -->
        ${(() => {
            const recetas = paciente.recetas || [];
            if (recetas.length > 0) {
                const ultima = recetas.sort((a, b) => new Date(b.fecha) - new Date(a.fecha))[0];
                return `
                    <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                        <h3 style="font-size: 16px; color: #002366; margin-bottom: 12px; font-weight: 700;">💊 Última Receta</h3>
                        <div style="font-size: 14px; color: #666; margin-bottom: 8px;">${formatDate(ultima.fecha)} - ${ultima.profesional}</div>
                        ${ultima.medicamentos.map(med => `
                            <div style="background: #e8f5e9; padding: 10px; border-radius: 6px; margin-bottom: 6px;">
                                <div style="font-weight: 600; font-size: 13px;">💊 ${med.nombre}</div>
                                <div style="font-size: 12px; color: #666;">${med.dosis} - ${med.frecuencia}</div>
                            </div>
                        `).join('')}
                    </div>
                `;
            }
            return '';
        })()}
    `;
}

function renderTabHistorial(paciente) {
    const facturasPaciente = getFacturasDePaciente(paciente);
    const citasPaciente = getCitasDePaciente(paciente).sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    const ordenesPaciente = (appData.laboratorios || []).filter(o => o.paciente === paciente.nombre);

    document.getElementById('tabHistorial').innerHTML = `
        <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 20px;">
            <h3 style="font-size: 16px; color: #002366; margin-bottom: 16px; font-weight: 700;">📋 Procedimientos</h3>
            ${facturasPaciente.length === 0 ? '<div style="text-align: center; padding: 40px; color: #999;">Sin procedimientos registrados</div>' :
            facturasPaciente.map(f => {
                const tieneCita = f.citaId ? appData.citas.find(c => c.id === f.citaId) : null;
                return `
                <div style="background: #f8f9fa; padding: 14px; border-radius: 8px; margin-bottom: 10px; border-left: 4px solid ${f.estado === 'pagada' ? '#28a745' : '#ffc107'};">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                        <div style="font-weight: 600; font-size: 15px;">${formatDate(f.fecha)}</div>
                        ${tieneCita ? `<div style="background: #007AFF; color: white; padding: 3px 10px; border-radius: 10px; font-size: 11px; font-weight: 600;">📅 ${f.citaHora}</div>` : ''}
                    </div>
                    <div style="font-size: 13px; color: #666; margin-bottom: 4px;"><strong>Procedimiento:</strong> ${f.procedimientos.map(p => p.nombre).join(', ')}</div>
                    <div style="font-size: 13px; color: #666; margin-bottom: 4px;"><strong>Profesional:</strong> ${f.profesional}</div>
                    <div style="font-size: 14px; font-weight: 600; margin-top: 8px; color: ${f.estado === 'pagada' ? '#28a745' : '#ffc107'};">
                        ${formatCurrency(f.total)} - ${f.estado === 'pagada' ? '✅ Pagada' : '⏳ Pendiente'}
                    </div>
                </div>
            `}).join('')}
        </div>

        <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); margin-bottom: 20px;">
            <h3 style="font-size: 16px; color: #002366; margin-bottom: 16px; font-weight: 700;">🔬 Laboratorio</h3>
            ${ordenesPaciente.length === 0 ? '<div style="text-align: center; padding: 40px; color: #999;">Sin órdenes de laboratorio</div>' :
            ordenesPaciente.map(o => {
                const colorEstado = getColorEstado(o.estadoActual);
                return `
                    <div style="background: #f8f9fa; padding: 14px; border-radius: 8px; margin-bottom: 10px; border-left: 4px solid ${colorEstado};">
                        <div style="font-weight: 600; font-size: 15px; margin-bottom: 6px;">${o.tipo}${o.dientes ? ` - Dientes: ${o.dientes}` : ''}</div>
                        <div style="font-size: 13px; color: #666; margin-bottom: 4px;"><strong>Estado:</strong> ${o.estadoActual}</div>
                        <div style="font-size: 13px; color: #666; margin-bottom: 4px;"><strong>Laboratorio:</strong> ${o.laboratorio}</div>
                        <div style="font-size: 14px; font-weight: 600; margin-top: 6px;">${formatCurrency(o.precio)} - ${formatDate(o.fechaCreacion)}</div>
                    </div>
                `;
            }).join('')}
        </div>

        <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <h3 style="font-size: 16px; color: #002366; margin-bottom: 16px; font-weight: 700;">📅 Citas</h3>
            ${citasPaciente.length === 0 ? '<div style="text-align: center; padding: 40px; color: #999;">Sin citas registradas</div>' :
            citasPaciente.map(c => {
                const colorEstado = getColorEstadoCita(c.estado || 'Pendiente');
                const iconoEstado = getIconoEstadoCita(c.estado || 'Pendiente');
                return `
                    <div style="background: #f8f9fa; padding: 14px; border-radius: 8px; margin-bottom: 10px; border-left: 4px solid ${colorEstado};">
                        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 6px;">
                            <div style="font-weight: 600; font-size: 15px;">${formatDate(c.fecha)} - ${c.hora}</div>
                            <div style="background: ${colorEstado}; color: white; padding: 3px 10px; border-radius: 10px; font-size: 11px; font-weight: 600;">
                                ${iconoEstado} ${c.estado || 'Pendiente'}
                            </div>
                        </div>
                        <div style="font-size: 13px; color: #666; margin-bottom: 4px;"><strong>Motivo:</strong> ${c.motivo}</div>
                        <div style="font-size: 13px; color: #666;"><strong>Profesional:</strong> ${c.profesional}</div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function renderTabRecetas(paciente) {
    const recetas = (paciente.recetas || []).sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    document.getElementById('tabRecetas').innerHTML = `
        <button class="btn btn-submit" onclick="currentPacienteRecetas = appData.pacientes.find(p => p.id === '${paciente.id}'); abrirNuevaReceta();" style="width: 100%; margin-bottom: 20px; font-size: 16px; padding: 14px;">
            ➕ Nueva Receta Médica
        </button>

        ${recetas.length === 0 ? `
            <div style="text-align: center; padding: 80px 20px; color: #999;">
                <div style="font-size: 64px; margin-bottom: 20px;">💊</div>
                <div style="font-size: 18px; font-weight: 600; margin-bottom: 10px;">Sin recetas médicas</div>
                <div style="font-size: 14px;">Crea la primera receta usando el botón de arriba</div>
            </div>
        ` : recetas.map(receta => `
            <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border-left: 4px solid #007AFF;">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 16px;">
                    <div>
                        <div style="font-size: 18px; font-weight: 700; color: #002366; margin-bottom: 4px;">${formatDate(receta.fecha)}</div>
                        <div style="font-size: 14px; color: #666;">${receta.profesional}</div>
                    </div>
                    <button class="btn btn-secondary" onclick="currentPacienteRecetas = appData.pacientes.find(p => p.id === '${paciente.id}'); descargarRecetaPDF('${receta.id}');" style="background: #28a745; color: white; font-size: 13px; padding: 8px 16px;">
                        📄 Descargar PDF
                    </button>
                </div>

                ${receta.diagnostico ? `
                    <div style="background: #f8f9fa; padding: 12px; border-radius: 8px; margin-bottom: 12px;">
                        <div style="font-size: 11px; color: #666; font-weight: 600; margin-bottom: 6px; text-transform: uppercase;">Diagnóstico</div>
                        <div style="font-size: 14px; color: #333;">${receta.diagnostico}</div>
                    </div>
                ` : ''}

                <div style="background: #e8f5e9; padding: 14px; border-radius: 8px; margin-bottom: 12px;">
                    <div style="font-size: 11px; color: #2e7d32; font-weight: 600; margin-bottom: 10px; text-transform: uppercase;">💊 Medicamentos</div>
                    ${receta.medicamentos.map(med => `
                        <div style="margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #c8e6c9;">
                            <div style="font-weight: 600; font-size: 14px; color: #1b5e20; margin-bottom: 4px;">💊 ${med.nombre}</div>
                            <div style="font-size: 13px; color: #666;">${med.dosis} - ${med.frecuencia}</div>
                            ${med.duracion ? `<div style="font-size: 12px; color: #666; margin-top: 2px;">Duración: ${med.duracion}</div>` : ''}
                        </div>
                    `).join('')}
                </div>

                ${receta.indicaciones ? `
                    <div style="background: #fff3e0; padding: 12px; border-radius: 8px;">
                        <div style="font-size: 11px; color: #e65100; font-weight: 600; margin-bottom: 6px; text-transform: uppercase;">Indicaciones</div>
                        <div style="font-size: 13px; color: #333; line-height: 1.6;">${receta.indicaciones}</div>
                    </div>
                ` : ''}
            </div>
        `).join('')}
    `;
}

function renderTabDocumentos(paciente) {
    const tieneConsentimiento = paciente.consentimiento && paciente.consentimiento.firmado;
    const totalPlacas = (paciente.placas || []).length;

    document.getElementById('tabDocumentos').innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px;">
            <!-- Consentimiento -->
            <div style="background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
                <div style="font-size: 48px; margin-bottom: 16px;">${tieneConsentimiento ? '✅' : '📋'}</div>
                <h3 style="font-size: 16px; color: #002366; margin-bottom: 8px; font-weight: 700;">Consentimiento Informado</h3>
                ${tieneConsentimiento ? `
                    <div style="color: #28a745; font-size: 14px; margin-bottom: 16px;">Firmado el ${formatDate(paciente.consentimiento.fecha)}</div>
                    <button class="btn btn-secondary" onclick="verFirma('${paciente.id}')" style="width: 100%; background: #28a745; color: white;">
                        📄 Descargar PDF
                    </button>
                ` : `
                    <div style="color: #ffc107; font-size: 14px; margin-bottom: 16px;">Pendiente de firma</div>
                    <button class="btn btn-submit" onclick="abrirConsentimiento('${paciente.id}')" style="width: 100%;">
                        ✍️ Firmar Ahora
                    </button>
                `}
            </div>

            <!-- Placas -->
            <div style="background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
                <div style="font-size: 48px; margin-bottom: 16px;">🦷</div>
                <h3 style="font-size: 16px; color: #002366; margin-bottom: 8px; font-weight: 700;">Placas Radiográficas</h3>
                <div style="color: #666; font-size: 14px; margin-bottom: 16px;">${totalPlacas} ${totalPlacas === 1 ? 'placa' : 'placas'} ${totalPlacas === 0 ? 'registradas' : 'registrada'}</div>
                <button class="btn btn-submit" onclick="abrirGaleriaPlacas('${paciente.id}')" style="width: 100%;">
                    ${totalPlacas === 0 ? '📤 Subir Primera Placa' : '👁️ Ver Galería'}
                </button>
            </div>
        </div>
    `;
}

function renderTabBalance(paciente) {
    const balance = calcularBalancePaciente(paciente.nombre);
    const facturasPaciente = getFacturasDePaciente(paciente);
    
    // Filtro robusto para estados (soporta inglés y español)
    const facturasPendientes = facturasPaciente.filter(f => {
        const estado = (f.estado || '').toLowerCase().trim();
        return estado === 'pendiente' || estado === 'pending' ||
               estado === 'parcial' || estado === 'partial';
    });
    
    const facturasCompletadas = facturasPaciente.filter(f => {
        const estado = (f.estado || '').toLowerCase().trim();
        return estado === 'pagada' || estado === 'paid';
    });
    
    // Calcular totales
    const totalFacturado = facturasPaciente.reduce((sum, f) => sum + f.total, 0);
    const totalPagado = facturasPaciente.reduce((sum, f) => {
        const pagado = (f.pagos || []).reduce((s, p) => s + p.monto, 0);
        return sum + pagado;
    }, 0);
    
    document.getElementById('tabBalance').innerHTML = `
        <!-- Resumen de Balance -->
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px; border-radius: 12px;">
                <div style="font-size: 14px; opacity: 0.9; margin-bottom: 8px;">BALANCE ACTUAL</div>
                <div style="font-size: 32px; font-weight: 700;">${formatCurrency(balance)}</div>
            </div>
            <div style="background: white; border: 2px solid #e5e5e7; padding: 24px; border-radius: 12px;">
                <div style="font-size: 14px; color: #666; margin-bottom: 8px;">TOTAL FACTURADO</div>
                <div style="font-size: 28px; font-weight: 700; color: #002366;">${formatCurrency(totalFacturado)}</div>
            </div>
            <div style="background: white; border: 2px solid #e5e5e7; padding: 24px; border-radius: 12px;">
                <div style="font-size: 14px; color: #666; margin-bottom: 8px;">TOTAL PAGADO</div>
                <div style="font-size: 28px; font-weight: 700; color: #28a745;">${formatCurrency(totalPagado)}</div>
            </div>
        </div>
        
        ${balance > 0 ? `
        <!-- Botón de Hacer Abono -->
        <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <div style="font-size: 16px; font-weight: 600; color: #856404; margin-bottom: 4px;">
                        💰 Realizar Abono al Balance
                    </div>
                    <div style="font-size: 14px; color: #856404;">
                        El paciente debe: ${formatCurrency(balance)}
                    </div>
                </div>
                <button class="btn btn-submit" onclick="abrirAbonoBalance('${paciente.id}')" style="font-size: 16px; padding: 12px 24px;">
                    💵 Hacer Abono
                </button>
            </div>
        </div>
        ` : balance < 0 ? `
        <div style="background: #d4edda; border: 2px solid #28a745; border-radius: 12px; padding: 20px; margin-bottom: 24px; text-align: center;">
            <div style="font-size: 18px; font-weight: 600; color: #155724;">
                ✅ El paciente tiene crédito a favor: ${formatCurrency(Math.abs(balance))}
            </div>
        </div>
        ` : `
        <div style="background: #d1ecf1; border: 2px solid #17a2b8; border-radius: 12px; padding: 20px; margin-bottom: 24px; text-align: center;">
            <div style="font-size: 18px; font-weight: 600; color: #0c5460;">
                ✅ El paciente no tiene balance pendiente
            </div>
        </div>
        `}
        
        <!-- Facturas Pendientes -->
        ${facturasPendientes.length > 0 ? `
        <div style="margin-bottom: 24px;">
            <h3 style="font-size: 18px; font-weight: 700; color: #002366; margin-bottom: 16px;">
                📋 Facturas Pendientes (${facturasPendientes.length})
            </h3>
            <div style="display: grid; gap: 12px;">
                ${facturasPendientes.map(f => {
                    const pagado = (f.pagos || []).reduce((sum, p) => sum + p.monto, 0);
                    const pendiente = f.total - pagado;
                    return `
                    <div style="background: #fff; border: 2px solid #e5e5e7; border-radius: 8px; padding: 16px;">
                        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
                            <div>
                                <div style="font-size: 16px; font-weight: 600; color: #002366;">${f.numero}</div>
                                <div style="font-size: 13px; color: #666; margin-top: 4px;">${formatDate(f.fecha)} • ${f.profesional}</div>
                            </div>
                            <div style="text-align: right;">
                                <div style="font-size: 18px; font-weight: 700; color: #ff3b30;">${formatCurrency(pendiente)}</div>
                                <div style="font-size: 12px; color: #666;">de ${formatCurrency(f.total)}</div>
                            </div>
                        </div>
                        ${pagado > 0 ? `<div style="font-size: 13px; color: #28a745; margin-bottom: 8px;">✓ Abonado: ${formatCurrency(pagado)}</div>` : ''}
                        <button class="btn btn-submit" onclick="abrirPagoFactura('${f.id}', '${paciente.id}')" style="width: 100%; font-size: 14px;">
                            💳 Pagar / Abonar
                        </button>
                    </div>
                    `;
                }).join('')}
            </div>
        </div>
        ` : ''}
        
        <!-- Facturas Completadas -->
        ${facturasCompletadas.length > 0 ? `
        <div>
            <h3 style="font-size: 18px; font-weight: 700; color: #002366; margin-bottom: 16px;">
                ✅ Facturas Pagadas (${facturasCompletadas.length})
            </h3>
            <div style="display: grid; gap: 12px;">
                ${facturasCompletadas.map(f => `
                    <div style="background: #f8f9fa; border: 2px solid #28a745; border-radius: 8px; padding: 16px; opacity: 0.8;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div>
                                <div style="font-size: 14px; font-weight: 600; color: #002366;">${f.numero}</div>
                                <div style="font-size: 12px; color: #666;">${formatDate(f.fecha)}</div>
                            </div>
                            <div style="text-align: right;">
                                <div style="font-size: 16px; font-weight: 700; color: #28a745;">${formatCurrency(f.total)}</div>
                                <div style="font-size: 11px; color: #28a745;">✓ PAGADA</div>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}
    `;
}

// ========================================
// MÓDULO DE AGENDA - VISTA SEMANAL
// ========================================

let agendaSemanaInicio = new Date();
agendaSemanaInicio.setDate(agendaSemanaInicio.getDate() - agendaSemanaInicio.getDay()); // Domingo
let verAgendaPropia = false; // Toggle para ver agenda propia vs general

function cambiarSemana(delta) {
    agendaSemanaInicio.setDate(agendaSemanaInicio.getDate() + (delta * 7));
    updateAgendaTab();
}

function toggleAgenda() {
    verAgendaPropia = !verAgendaPropia;
    updateAgendaTab();
}

function updateAgendaTab() {
    // Inicializar filtro de profesionales
    inicializarFiltrosProfesionales();

    const inicio = new Date(agendaSemanaInicio);
    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + 6); // Hasta sábado

    const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    document.getElementById('agendaSemanaTexto').textContent =
        `${inicio.getDate()} ${meses[inicio.getMonth()]} - ${fin.getDate()} ${meses[fin.getMonth()]} ${fin.getFullYear()}`;

    // Filtrar citas de la semana (EXCLUIR CANCELADAS)
    const citasSemana = appData.citas.filter(c => {
        const citaDate = new Date(c.fecha);
        const enRango = citaDate >= inicio && citaDate <= fin;
        const noCancelada = c.estado !== 'Cancelada';
        return enRango && noCancelada;
    });

    // Filtrar por rol y toggle
    const role = appData.currentRole;
    let citasFiltradas = citasSemana;

    if (role === 'professional') {
        if (verAgendaPropia) {
            citasFiltradas = citasSemana.filter(c => c.profesional === appData.currentUser);
        }
        // Si no, ve todas (agenda general)
    }

    // Aplicar filtros adicionales
    citasFiltradas = aplicarFiltrosCitas(citasFiltradas);

    // Botón de toggle solo para profesionales
    const toggleBtn = role === 'professional' ?
        `<button class="btn" onclick="toggleAgenda()" style="margin-left: 10px;">${verAgendaPropia ? '👁️ Ver Agenda General' : '👤 Ver Mi Agenda'}</button>` : '';

    document.getElementById('agendaToggle').innerHTML = toggleBtn;

    // Renderizar vista semanal
    const dias = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const colores = {1: '#007AFF', 2: '#34C759', 3: '#FF9500', 4: '#AF52DE'};

    let html = '<div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px;">';

    for (let i = 0; i < 7; i++) {
        const dia = new Date(inicio);
        dia.setDate(dia.getDate() + i);

        const citasDelDia = citasFiltradas.filter(c => {
            const citaDate = new Date(c.fecha);
            return citaDate.toDateString() === dia.toDateString();
        }).sort((a, b) => a.hora.localeCompare(b.hora));

        const esHoy = dia.toDateString() === new Date().toDateString();

        html += `
            <div style="border: 2px solid ${esHoy ? '#002366' : '#e5e5e7'}; border-radius: 8px; padding: 10px; min-height: 400px; background: ${esHoy ? '#f0f4ff' : 'white'};">
                <div style="text-align: center; margin-bottom: 12px;">
                    <div style="font-size: 12px; color: #666; font-weight: 600;">${dias[i]}</div>
                    <div style="font-size: 20px; font-weight: 700; color: ${esHoy ? '#002366' : '#1d1d1f'};">${dia.getDate()}</div>
                </div>
                ${citasDelDia.map(c => {
                    const estadoCita = c.estado || 'Pendiente';
                    const colorEstado = getColorEstadoCita(estadoCita);
                    const iconoEstado = getIconoEstadoCita(estadoCita);

                    return `
                    <div onclick="verDetalleCita('${c.id}')" style="background: ${colores[c.consultorio]}; color: white; padding: 8px; border-radius: 6px; margin-bottom: 6px; cursor: pointer; transition: transform 0.2s; border-left: 4px solid ${colorEstado};" onmouseover="this.style.transform='scale(1.02)'" onmouseout="this.style.transform='scale(1)'">
                        <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px;">${c.hora}</div>
                        <div style="font-size: 11px; opacity: 0.95; margin-bottom: 2px;">${c.paciente}</div>
                        <div style="font-size: 10px; opacity: 0.9;">${c.profesional}</div>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
                            <div style="font-size: 10px; opacity: 0.85;">C${c.consultorio}</div>
                            <div style="background: ${colorEstado}; padding: 2px 6px; border-radius: 10px; font-size: 9px; font-weight: 600;">
                                ${iconoEstado} ${estadoCita}
                            </div>
                        </div>
                    </div>
                `}).join('')}
            </div>
        `;
    }

    html += '</div>';
    document.getElementById('calendarioAgenda').innerHTML = html;
}

function verDetalleCita(citaId) {
    currentCitaIdDetalle = citaId; // Guardar para usar en botón cancelar
    const cita = appData.citas.find(c => c.id === citaId);
    if (!cita) return;

    const colores = {1: '#007AFF', 2: '#34C759', 3: '#FF9500', 4: '#AF52DE'};

    const html = `
        <div style="background: ${colores[cita.consultorio]}; color: white; padding: 20px; border-radius: 12px; margin-bottom: 20px;">
            <div style="font-size: 28px; font-weight: 700; margin-bottom: 8px;">${cita.hora}</div>
            <div style="font-size: 14px; opacity: 0.9;">Consultorio ${cita.consultorio}</div>
        </div>

        <!-- ESTADO DE LA CITA -->
        <div style="background: ${getColorEstadoCita(cita.estado || 'Pendiente')}; color: white; padding: 14px; border-radius: 8px; margin-bottom: 16px; text-align: center;">
            <div style="font-size: 12px; opacity: 0.9; margin-bottom: 4px;">ESTADO ACTUAL</div>
            <div style="font-size: 20px; font-weight: 700;">${getIconoEstadoCita(cita.estado || 'Pendiente')} ${cita.estado || 'Pendiente'}</div>
        </div>

        <!-- CAMBIAR ESTADO -->
        <div style="background: #f8f9fa; padding: 14px; border-radius: 8px; margin-bottom: 16px;">
            <label style="font-size: 12px; color: #666; margin-bottom: 8px; display: block; font-weight: 600;">CAMBIAR ESTADO</label>
            <select id="nuevoEstadoCita" style="width: 100%; padding: 12px; border: 2px solid #e5e5e7; border-radius: 8px; font-size: 14px; font-weight: 500;">
                <option value="Pendiente" ${(cita.estado || 'Pendiente') === 'Pendiente' ? 'selected' : ''}>⏳ Pendiente</option>
                <option value="Confirmada" ${cita.estado === 'Confirmada' ? 'selected' : ''}>✅ Confirmada</option>
                <option value="En Sala de Espera" ${cita.estado === 'En Sala de Espera' ? 'selected' : ''}>🏥 En Sala de Espera</option>
                <option value="Completada" ${cita.estado === 'Completada' ? 'selected' : ''}>✔️ Completada</option>
                <option value="Cancelada" ${cita.estado === 'Cancelada' ? 'selected' : ''}>❌ Cancelada</option>
                <option value="Inasistencia" ${cita.estado === 'Inasistencia' ? 'selected' : ''}>⚠️ Inasistencia (No vino)</option>
            </select>
            <button class="btn btn-submit" style="margin-top: 10px; width: 100%;" onclick="cambiarEstadoCita('${cita.id}', document.getElementById('nuevoEstadoCita').value)">
                Actualizar Estado
            </button>
        </div>

        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin-bottom: 16px;">
            <div style="background: #f8f9fa; padding: 14px; border-radius: 8px;">
                <div style="font-size: 10px; color: #666; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Paciente</div>
                <div style="font-size: 16px; font-weight: 600; color: #1d1d1f;">${cita.paciente}</div>
            </div>
            <div style="background: #f8f9fa; padding: 14px; border-radius: 8px;">
                <div style="font-size: 10px; color: #666; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Profesional</div>
                <div style="font-size: 16px; font-weight: 600; color: #1d1d1f;">${cita.profesional}</div>
            </div>
        </div>

        <div style="background: #f8f9fa; padding: 14px; border-radius: 8px; margin-bottom: 16px;">
            <div style="font-size: 10px; color: #666; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Fecha</div>
            <div style="font-size: 15px; font-weight: 500; color: #1d1d1f;">${formatDate(cita.fecha)}</div>
        </div>

        <div style="background: #e7f3ff; padding: 14px; border-radius: 8px;">
            <div style="font-size: 10px; color: #004085; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Motivo</div>
            <div style="font-size: 15px; font-weight: 500; color: #1d1d1f;">${cita.motivo}</div>
        </div>

        ${cita.procedimientosRealizados ? `
        <div style="background: #d4edda; padding: 14px; border-radius: 8px; margin-top: 16px;">
            <div style="font-size: 10px; color: #155724; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">✅ Procedimientos Realizados</div>
            <div style="font-size: 14px; font-weight: 500; color: #155724;">${cita.procedimientosRealizados}</div>
        </div>
        ` : ''}

        ${cita.notasProcedimiento ? `
        <div style="background: #fff3cd; padding: 14px; border-radius: 8px; margin-top: 16px;">
            <div style="font-size: 10px; color: #856404; margin-bottom: 4px; text-transform: uppercase; font-weight: 600;">Notas del Procedimiento</div>
            <div style="font-size: 14px; font-weight: 500; color: #1d1d1f;">${cita.notasProcedimiento}</div>
        </div>
        ` : ''}
    `;

    document.getElementById('detalleCitaContent').innerHTML = html;
    openModal('modalDetalleCita');
}

function abrirModalNuevaCita() {
    // Autocomplete input en lugar de select
    document.getElementById('citaPacienteInput').value = '';
    document.getElementById('citaPacienteSuggestions').innerHTML = '';
    document.getElementById('citaPacienteSuggestions').style.display = 'none';

    const profesionales = appData.personal.filter(p => p.tipo !== 'empleado');

    const selectProf = document.getElementById('citaProfesional');
    selectProf.innerHTML = '<option value="">Seleccione profesional</option>' +
        profesionales.map(p => `<option value="${p.nombre}">${p.nombre}</option>`).join('');

    document.getElementById('citaFecha').value = new Date().toISOString().split('T')[0];
    document.getElementById('citaHora').value = '09:00';
    document.getElementById('citaConsultorio').value = '1';
    document.getElementById('citaMotivo').value = '';

    openModal('modalNuevaCita');
}

// Autocomplete para pacientes
function buscarPaciente() {
    const input = document.getElementById('citaPacienteInput');
    const query = input.value.toLowerCase();
    const suggestions = document.getElementById('citaPacienteSuggestions');

    // Resetear flag de selección cuando el usuario escribe
    input.dataset.pacienteSeleccionado = 'false';

    if (query.length < 2) {
        suggestions.style.display = 'none';
        return;
    }

    const matches = appData.pacientes.filter(p =>
        p.nombre.toLowerCase().includes(query)
    ).slice(0, 5);

    if (matches.length === 0) {
        suggestions.style.display = 'none';
        return;
    }

    suggestions.innerHTML = matches.map(p => `
        <div onclick="seleccionarPaciente('${p.nombre}')" style="padding: 10px; cursor: pointer; border-bottom: 1px solid #e5e5e7; transition: background 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">
            <div style="font-weight: 600; font-size: 14px;">${p.nombre}</div>
            <div style="font-size: 12px; color: #666;">${p.telefono || 'Sin teléfono'} ${p.cedula ? '• ' + p.cedula : ''}</div>
        </div>
    `).join('');

    suggestions.style.display = 'block';
}

function seleccionarPaciente(nombre) {
    const input = document.getElementById('citaPacienteInput');
    input.value = nombre;
    input.dataset.pacienteSeleccionado = 'true'; // Marcar que se seleccionó de la lista
    document.getElementById('citaPacienteSuggestions').style.display = 'none';

    // Guardar ID del paciente para vinculación correcta
    const pac = appData.pacientes.find(p => p.nombre === nombre);
    input.dataset.pacienteId = pac ? pac.id : '';
}

async function guardarCita() {
    const pacienteInput = document.getElementById('citaPacienteInput');
    const paciente = pacienteInput.value.trim();
    const profesional = document.getElementById('citaProfesional').value;
    const fecha = document.getElementById('citaFecha').value;
    const hora = document.getElementById('citaHora').value;
    const consultorio = parseInt(document.getElementById('citaConsultorio').value);
    const motivo = document.getElementById('citaMotivo').value.trim();

    if (!paciente || !profesional || !fecha || !hora || !consultorio || !motivo) {
        alert('Complete todos los campos');
        return;
    }

    // VALIDACIÓN ESTRICTA: El paciente debe haber sido seleccionado de la lista
    if (!pacienteInput.dataset.pacienteSeleccionado || pacienteInput.dataset.pacienteSeleccionado !== 'true') {
        alert('❌ Debe seleccionar el paciente de la lista de sugerencias.\n\nNo puede escribir el nombre libremente.');
        return;
    }

    // VALIDACIÓN: La fecha no puede ser en el pasado
    const fechaSeleccionada = new Date(fecha);
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    fechaSeleccionada.setHours(0, 0, 0, 0);

    if (fechaSeleccionada < hoy) {
        alert('❌ No puedes crear una cita en el pasado.\n\nPor favor selecciona una fecha de hoy en adelante.');
        return;
    }

    // VALIDACIÓN: Horario de citas solo de 8am a 8pm
    const [horaNum, minutos] = hora.split(':').map(Number);
    if (horaNum < 8 || horaNum >= 20) {
        alert('❌ Las citas solo se pueden agendar entre 8:00 AM y 8:00 PM.\n\nPor favor selecciona otro horario.');
        return;
    }

    // VALIDAR SOLAPAMIENTO
    const fechaHoraNueva = new Date(fecha + 'T' + hora);

    // Buscar citas que se solapen en el mismo consultorio
    // Ignorar citas Canceladas, Inasistencias y Completadas
    const estadosIgnorar = ['Cancelada', 'Inasistencia', 'Completada'];
    const citasSolapadas = appData.citas.filter(c => {
        if (c.consultorio !== consultorio) return false;
        if (estadosIgnorar.includes(c.estado)) return false; // ← Fix

        const fechaHoraCita = new Date(c.fecha);
        const diferenciaMinutos = Math.abs((fechaHoraNueva - fechaHoraCita) / (1000 * 60));

        return diferenciaMinutos < 30;
    });

    if (citasSolapadas.length > 0) {
        const citaSolapada = citasSolapadas[0];
        alert(`⚠️ CITA SE SOLAPA\n\nEl Consultorio ${consultorio} ya tiene una cita:\n\n` +
              `Paciente: ${citaSolapada.paciente}\n` +
              `Hora: ${citaSolapada.hora}\n` +
              `Profesional: ${citaSolapada.profesional}\n\n` +
              `Por favor elige otra hora o consultorio.`);
        return;
    }

    const cita = {
        id: generateId('CITA-'),
        paciente,
        pacienteId: document.getElementById('citaPacienteInput').dataset.pacienteId || null,
        profesional,
        fecha: fecha + 'T' + hora,
        hora,
        consultorio,
        motivo,
        estado: 'Pendiente',
        creadoPor: appData.currentUser,
        fechaCreacion: new Date().toISOString()
    };

    appData.citas.push(cita);
    await saveData();
    closeModal('modalNuevaCita');
    updateAgendaTab();
    alert('✅ Cita creada exitosamente');
}

// ========================================
// SISTEMA DE LABORATORIO COMPLETO
// ========================================

// Órdenes de laboratorio temporales (para agregar a factura)
let tempOrdenesLab = [];

function abrirModalOrdenLab() {
    document.getElementById('labTipo').value = 'Corona';
    document.getElementById('labDientes').value = '';
    document.getElementById('labDescripcion').value = '';
    document.getElementById('labLaboratorio').value = '';
    document.getElementById('labPrecio').value = '';
    document.getElementById('labCosto').value = '';
    calcularMargenLab();

    openModal('modalOrdenLab');
}

function calcularMargenLab() {
    const precio = parseFloat(document.getElementById('labPrecio').value) || 0;
    const costo = parseFloat(document.getElementById('labCosto').value) || 0;
    const margen = precio - costo;

    document.getElementById('labMargen').textContent = formatCurrency(margen);

    const margenEl = document.getElementById('labMargen');
    if (margen < 0) {
        margenEl.style.color = '#dc3545';
    } else if (margen > 0) {
        margenEl.style.color = '#28a745';
    } else {
        margenEl.style.color = '#666';
    }
}

function agregarOrdenLabAFactura() {
    const tipo = document.getElementById('labTipo').value;
    const dientes = document.getElementById('labDientes').value.trim();
    const descripcion = document.getElementById('labDescripcion').value.trim();
    const laboratorio = document.getElementById('labLaboratorio').value.trim();
    const precio = parseFloat(document.getElementById('labPrecio').value) || 0;
    const costo = parseFloat(document.getElementById('labCosto').value) || 0;

    if (!descripcion) {
        alert('Por favor ingresa una descripción');
        return;
    }

    if (!laboratorio) {
        alert('Por favor ingresa el nombre del laboratorio');
        return;
    }

    if (precio <= 0) {
        alert('❌ El precio debe ser mayor a 0');
        return;
    }

    // VALIDACIÓN: Costo no puede ser negativo
    if (costo < 0) {
        alert('❌ El costo no puede ser negativo');
        return;
    }

    const orden = {
        id: generateId('TEMP-LAB-'),
        tipo: tipo,
        dientes: dientes,
        descripcion: descripcion,
        laboratorio: laboratorio,
        precio: precio,
        costo: costo,
        margen: precio - costo
    };

    tempOrdenesLab.push(orden);
    updateListaOrdenesLabTemp();
    updateTotal();  // ← CORREGIDO: Actualizar total de la factura
    closeModal('modalOrdenLab');
}

function updateListaOrdenesLabTemp() {
    const lista = document.getElementById('listaOrdenesLabTemp');

    if (!lista) return;

    if (tempOrdenesLab.length === 0) {
        lista.innerHTML = '<p style="text-align: center; color: #999; padding: 20px;">No hay órdenes de laboratorio</p>';
        return;
    }

    lista.innerHTML = tempOrdenesLab.map((orden, index) => `
        <div style="background: #f8f9fa; padding: 12px; border-radius: 8px; margin-bottom: 8px; border-left: 4px solid #007AFF;">
            <div style="display: flex; justify-content: space-between; align-items: start;">
                <div style="flex: 1;">
                    <div style="font-weight: 600; color: #002366; margin-bottom: 4px;">
                        ${orden.tipo}${orden.dientes ? ` - Dientes: ${orden.dientes}` : ''}
                    </div>
                    <div style="font-size: 13px; color: #666; margin-bottom: 2px;">
                        ${orden.descripcion}
                    </div>
                    <div style="font-size: 12px; color: #666;">
                        Lab: ${orden.laboratorio}
                    </div>
                    <div style="font-size: 13px; margin-top: 4px;">
                        <span style="color: #28a745; font-weight: 600;">Precio: ${formatCurrency(orden.precio)}</span>
                        <span style="color: #666; margin-left: 10px;">Costo: ${formatCurrency(orden.costo)}</span>
                        <span style="color: ${orden.margen >= 0 ? '#28a745' : '#dc3545'}; margin-left: 10px; font-weight: 600;">
                            Margen: ${formatCurrency(orden.margen)}
                        </span>
                    </div>
                </div>
                <button class="btn btn-danger" style="margin-left: 10px;" onclick="eliminarOrdenLabTemp(${index})">
                    🗑️
                </button>
            </div>
        </div>
    `).join('');
}

function eliminarOrdenLabTemp(index) {
    tempOrdenesLab.splice(index, 1);
    updateListaOrdenesLabTemp();
    updateTotal();  // ← CORREGIDO: Actualizar total
}

async function crearOrdenesLabDesdeFactura(factura) {
    if (tempOrdenesLab.length === 0) return;

    const ordenesLab = tempOrdenesLab.map(temp => ({
        id: generateId('LAB-'),
        facturaId: factura.id,
        facturaNumero: factura.numero,
        paciente: factura.paciente,
        profesional: factura.profesional,
        tipo: temp.tipo,
        dientes: temp.dientes,
        descripcion: temp.descripcion,
        laboratorio: temp.laboratorio,
        precio: temp.precio,
        costo: temp.costo,
        margen: temp.margen,
        timeline: [
            {
                estado: 'Toma de impresión',
                fecha: new Date().toISOString(),
                usuario: appData.currentUser,
                notas: 'Impresión tomada'
            }
        ],
        estadoActual: 'Toma de impresión',
        fechaCreacion: new Date().toISOString(),
        creadoPor: appData.currentUser
    }));

    if (!appData.laboratorios) {
        appData.laboratorios = [];
    }
    appData.laboratorios.push(...ordenesLab);

    tempOrdenesLab = [];
    updateListaOrdenesLabTemp();

    await saveData();
}

function updateLaboratorioTab() {
    if (!appData.laboratorios) {
        appData.laboratorios = [];
    }

    const filtroEstado = document.getElementById('filtroEstadoLab')?.value || 'todos';
    const filtroProfesional = document.getElementById('filtroProfesionalLab')?.value || 'todos';

    let ordenesFiltradas = appData.laboratorios;

    if (filtroEstado !== 'todos') {
        ordenesFiltradas = ordenesFiltradas.filter(o => o.estadoActual === filtroEstado);
    }

    if (appData.currentRole === 'professional') {
        ordenesFiltradas = ordenesFiltradas.filter(o => o.profesional === appData.currentUser);
    } else if (filtroProfesional !== 'todos') {
        ordenesFiltradas = ordenesFiltradas.filter(o => o.profesional === filtroProfesional);
    }

    ordenesFiltradas.sort((a, b) => new Date(b.fechaCreacion) - new Date(a.fechaCreacion));

    const porEstado = {
        'Toma de impresión': appData.laboratorios.filter(o => o.estadoActual === 'Toma de impresión').length,
        'Enviado a laboratorio': appData.laboratorios.filter(o => o.estadoActual === 'Enviado a laboratorio').length,
        'Listo para prueba': appData.laboratorios.filter(o => o.estadoActual === 'Listo para prueba').length,
        'Entregado': appData.laboratorios.filter(o => o.estadoActual === 'Entregado').length
    };

    document.getElementById('statsLaboratorio').innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 20px;">
            <div style="background: #fff3cd; padding: 15px; border-radius: 8px; text-align: center;">
                <div style="font-size: 24px; font-weight: 700; color: #856404;">${porEstado['Toma de impresión']}</div>
                <div style="font-size: 12px; color: #666; margin-top: 5px;">Impresión</div>
            </div>
            <div style="background: #cfe2ff; padding: 15px; border-radius: 8px; text-align: center;">
                <div style="font-size: 24px; font-weight: 700; color: #084298;">${porEstado['Enviado a laboratorio']}</div>
                <div style="font-size: 12px; color: #666; margin-top: 5px;">En Laboratorio</div>
            </div>
            <div style="background: #fff3cd; padding: 15px; border-radius: 8px; text-align: center;">
                <div style="font-size: 24px; font-weight: 700; color: #856404;">${porEstado['Listo para prueba']}</div>
                <div style="font-size: 12px; color: #666; margin-top: 5px;">Para Prueba</div>
            </div>
            <div style="background: #d1e7dd; padding: 15px; border-radius: 8px; text-align: center;">
                <div style="font-size: 24px; font-weight: 700; color: #0f5132;">${porEstado['Entregado']}</div>
                <div style="font-size: 12px; color: #666; margin-top: 5px;">Entregados</div>
            </div>
        </div>
    `;

    const lista = document.getElementById('listaLaboratorio');

    if (ordenesFiltradas.length === 0) {
        lista.innerHTML = '<p style="text-align: center; padding: 40px; color: #999;">No hay órdenes de laboratorio</p>';
        return;
    }

    lista.innerHTML = ordenesFiltradas.map(orden => {
        const ultimoEvento = orden.timeline[orden.timeline.length - 1];
        const colorEstado = getColorEstado(orden.estadoActual);

        return `
            <div style="background: white; border: 1px solid #e0e0e0; border-left: 4px solid ${colorEstado}; border-radius: 8px; padding: 15px; margin-bottom: 12px; cursor: pointer;" onclick="verDetalleOrdenLab('${orden.id}')">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px;">
                    <div style="flex: 1;">
                        <div style="font-size: 16px; font-weight: 700; color: #002366; margin-bottom: 4px;">
                            ${orden.tipo}${orden.dientes ? ` - ${orden.dientes}` : ''}
                        </div>
                        <div style="font-size: 14px; color: #666; margin-bottom: 2px;">
                            👤 ${orden.paciente}
                        </div>
                        <div style="font-size: 13px; color: #666;">
                            👨‍⚕️ ${orden.profesional} • 🏥 ${orden.laboratorio}
                        </div>
                    </div>
                    <div style="text-align: right;">
                        <div style="background: ${colorEstado}; color: white; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-bottom: 8px;">
                            ${orden.estadoActual}
                        </div>
                        <div style="font-size: 14px; font-weight: 700; color: #28a745;">
                            ${formatCurrency(orden.precio)}
                        </div>
                    </div>
                </div>
                <div style="font-size: 12px; color: #999;">
                    📅 ${formatDate(ultimoEvento.fecha)} • ${ultimoEvento.usuario}
                    ${ultimoEvento.notas ? ` • ${ultimoEvento.notas}` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function getColorEstado(estado) {
    const colores = {
        'Toma de impresión': '#ffc107',
        'Enviado a laboratorio': '#007AFF',
        'Listo para prueba': '#ff9500',
        'Reenviado a laboratorio': '#dc3545',
        'Entregado': '#28a745'
    };
    return colores[estado] || '#666';
}

function verDetalleOrdenLab(ordenId) {
    const orden = appData.laboratorios.find(o => o.id === ordenId);
    if (!orden) return;

    document.getElementById('detalleLabInfo').innerHTML = `
        <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
            <div style="font-size: 18px; font-weight: 700; color: #002366; margin-bottom: 10px;">
                ${orden.tipo}${orden.dientes ? ` - Dientes: ${orden.dientes}` : ''}
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 10px;">
                <div>
                    <div style="font-size: 11px; color: #666; text-transform: uppercase; font-weight: 600;">Paciente</div>
                    <div style="font-size: 14px; font-weight: 500;">${orden.paciente}</div>
                </div>
                <div>
                    <div style="font-size: 11px; color: #666; text-transform: uppercase; font-weight: 600;">Profesional</div>
                    <div style="font-size: 14px; font-weight: 500;">${orden.profesional}</div>
                </div>
                <div>
                    <div style="font-size: 11px; color: #666; text-transform: uppercase; font-weight: 600;">Laboratorio</div>
                    <div style="font-size: 14px; font-weight: 500;">${orden.laboratorio}</div>
                </div>
                <div>
                    <div style="font-size: 11px; color: #666; text-transform: uppercase; font-weight: 600;">Factura</div>
                    <div style="font-size: 14px; font-weight: 500;">${orden.facturaNumero}</div>
                </div>
            </div>
            <div style="margin-top: 10px;">
                <div style="font-size: 11px; color: #666; text-transform: uppercase; font-weight: 600;">Descripción</div>
                <div style="font-size: 14px;">${orden.descripcion}</div>
            </div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 15px; padding-top: 15px; border-top: 1px solid #dee2e6;">
                <div>
                    <div style="font-size: 11px; color: #666;">Precio</div>
                    <div style="font-size: 16px; font-weight: 700; color: #28a745;">${formatCurrency(orden.precio)}</div>
                </div>
                <div>
                    <div style="font-size: 11px; color: #666;">Costo</div>
                    <div style="font-size: 16px; font-weight: 700; color: #dc3545;">${formatCurrency(orden.costo)}</div>
                </div>
                <div>
                    <div style="font-size: 11px; color: #666;">Margen</div>
                    <div style="font-size: 16px; font-weight: 700; color: ${orden.margen >= 0 ? '#28a745' : '#dc3545'};">
                        ${formatCurrency(orden.margen)}
                    </div>
                </div>
            </div>
        </div>
    `;

    document.getElementById('detalleLabTimeline').innerHTML = orden.timeline.map((evento, index) => {
        const isLast = index === orden.timeline.length - 1;
        const color = getColorEstado(evento.estado);

        return `
            <div style="display: flex; margin-bottom: ${isLast ? '0' : '20px'};">
                <div style="display: flex; flex-direction: column; align-items: center; margin-right: 15px;">
                    <div style="width: 12px; height: 12px; background: ${color}; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 0 2px ${color};"></div>
                    ${!isLast ? `<div style="width: 2px; flex: 1; background: #dee2e6; margin: 4px 0;"></div>` : ''}
                </div>
                <div style="flex: 1; padding-bottom: ${isLast ? '0' : '10px'};">
                    <div style="font-weight: 600; color: #002366; margin-bottom: 4px;">${evento.estado}</div>
                    <div style="font-size: 12px; color: #666; margin-bottom: 2px;">
                        📅 ${formatDate(evento.fecha)} ${formatTime(evento.fecha)}
                    </div>
                    <div style="font-size: 12px; color: #666;">
                        👤 ${evento.usuario}
                        ${evento.notas ? ` • ${evento.notas}` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    window.currentOrdenLabId = ordenId;

    const botonesHTML = renderizarBotonesAvance(orden);
    document.getElementById('botonesAvanceLab').innerHTML = botonesHTML;

    openModal('modalDetalleOrdenLab');
}

function renderizarBotonesAvance(orden) {
    const estadoActual = orden.estadoActual;

    if (estadoActual === 'Entregado') {
        return '<p style="text-align: center; color: #28a745; font-weight: 600;">✅ Orden completada y entregada</p>';
    }

    let botones = [];

    if (estadoActual === 'Toma de impresión') {
        botones.push({
            text: '📤 Enviar a Laboratorio',
            color: '#007AFF',
            estado: 'Enviado a laboratorio'
        });
    }

    if (estadoActual === 'Enviado a laboratorio') {
        botones.push({
            text: '✅ Marcar Listo para Prueba',
            color: '#ff9500',
            estado: 'Listo para prueba'
        });
    }

    if (estadoActual === 'Listo para prueba') {
        botones.push({
            text: '🔄 Reenviar a Laboratorio',
            color: '#dc3545',
            estado: 'Reenviado a laboratorio'
        });
        botones.push({
            text: '🎉 Marcar como Entregado',
            color: '#28a745',
            estado: 'Entregado'
        });
    }

    if (estadoActual === 'Reenviado a laboratorio') {
        botones.push({
            text: '✅ Listo para Prueba (otra vez)',
            color: '#ff9500',
            estado: 'Listo para prueba'
        });
    }

    return botones.map((btn, index) => `
        <button
            class="btn"
            style="background: ${btn.color}; color: white; margin: 5px;"
            onclick="avanzarEstadoLab('${btn.estado}')"
            data-estado="${btn.estado}"
        >
            ${btn.text}
        </button>
    `).join('');
}

async function avanzarEstadoLab(nuevoEstado) {
    // Solo profesionales y admin pueden avanzar estados de laboratorio
    if (appData.currentRole === 'reception') {
        alert('❌ Solo los profesionales o el administrador pueden actualizar el estado del laboratorio.');
        return;
    }

    if (!window.currentOrdenLabId) {
        alert('Error: No hay orden seleccionada');
        return;
    }

    const orden = appData.laboratorios.find(o => o.id === window.currentOrdenLabId);

    if (!orden) {
        alert('Error: Orden no encontrada');
        return;
    }

    const notas = prompt(`Notas para el cambio a "${nuevoEstado}":\n\n(Puedes dejar vacío si no hay notas)`);

    if (notas === null) return; // Usuario canceló

    orden.timeline.push({
        estado: nuevoEstado,
        fecha: new Date().toISOString(),
        usuario: appData.currentUser,
        notas: notas.trim() || 'Sin notas adicionales'
    });

    orden.estadoActual = nuevoEstado;

    await saveData();

    verDetalleOrdenLab(orden.id);
    updateLaboratorioTab();
}

function formatTime(isoDate) {
    const date = new Date(isoDate);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

// ========================================
// SISTEMA DE ESTADOS DE CITAS
// ========================================

function getColorEstadoCita(estado) {
    const colores = {
        'Pendiente': '#ffc107',
        'Confirmada': '#007AFF',
        'En Sala de Espera': '#ff9500',
        'Completada': '#28a745',
        'Cancelada': '#6c757d',
        'Inasistencia': '#dc3545'
    };
    return colores[estado] || '#999';
}

function getIconoEstadoCita(estado) {
    const iconos = {
        'Pendiente': '⏳',
        'Confirmada': '✅',
        'En Sala de Espera': '🏥',
        'Completada': '✔️',
        'Cancelada': '❌',
        'Inasistencia': '⚠️'
    };
    return iconos[estado] || '📅';
}

async function cambiarEstadoCita(citaId, nuevoEstado) {
    const cita = appData.citas.find(c => c.id === citaId);
    if (!cita) {
        alert('Cita no encontrada');
        return;
    }

    const estadoAnterior = cita.estado || 'Pendiente';

    // VALIDACIÓN: Si se marca como Completada, debe tener factura
    if (nuevoEstado === 'Completada' && !cita.facturaId) {
        const confirmar = confirm(
            '⚠️ ATENCIÓN: Esta cita no tiene factura asociada.\n\n' +
            '¿Deseas marcarla como Completada de todas formas?\n\n' +
            'Recomendación: Genera primero la factura para vincularla automáticamente.'
        );
        if (!confirmar) return;
    }

    // Confirmar cambio
    if (!confirm(`¿Cambiar estado de "${estadoAnterior}" a "${nuevoEstado}"?`)) {
        return;
    }

    // Inicializar historial si no existe
    if (!cita.historialEstados) {
        cita.historialEstados = [{
            estado: estadoAnterior,
            fecha: cita.fechaCreacion || cita.fecha,
            usuario: cita.creadoPor || 'Sistema',
            notas: 'Estado inicial'
        }];
    }

    // Agregar cambio al historial
    cita.historialEstados.push({
        estado: nuevoEstado,
        fecha: new Date().toISOString(),
        usuario: appData.currentUser,
        notas: ''
    });

    // Cambiar estado
    cita.estado = nuevoEstado;
    cita.ultimaModificacion = new Date().toISOString();
    cita.modificadoPor = appData.currentUser;

    // Si se marca como completada, agregar nota
    if (nuevoEstado === 'Completada') {
        const notas = prompt('Notas del procedimiento realizado (opcional):');
        if (notas) {
            cita.notasProcedimiento = notas;
            // Agregar notas al último registro del historial
            cita.historialEstados[cita.historialEstados.length - 1].notas = notas;
        }
    }

    await saveData();
    updateAgendaTab();
    closeModal('modalDetalleCita');

    alert(`✅ Estado actualizado a: ${nuevoEstado}`);
}

// Función para inicializar estados en citas existentes
function inicializarEstadosCitas() {
    let actualizadas = 0;
    appData.citas.forEach(cita => {
        if (!cita.estado) {
            cita.estado = 'Pendiente';
            actualizadas++;
        }
    });
    if (actualizadas > 0) {
        console.log(`✅ ${actualizadas} citas actualizadas con estado inicial`);
        saveData();
    }
}

// ========================================
// AUTOCOMPLETE DE PACIENTES EN FACTURA
// ========================================

function buscarPacienteFactura() {
    const input = document.getElementById('pacienteNombre');
    const query = input.value.toLowerCase();
    const suggestions = document.getElementById('pacienteNombreSuggestions');

    // Resetear flag de selección cuando el usuario escribe
    input.dataset.pacienteSeleccionado = 'false';

    if (query.length < 2) {
        suggestions.style.display = 'none';
        return;
    }

    const matches = appData.pacientes.filter(p =>
        p.nombre.toLowerCase().includes(query) ||
        (p.cedula && p.cedula.includes(query)) ||
        (p.telefono && p.telefono.includes(query))
    ).slice(0, 5);

    if (matches.length === 0) {
        suggestions.style.display = 'none';
        return;
    }

    suggestions.innerHTML = matches.map(p => `
        <div onclick="seleccionarPacienteFactura('${p.nombre.replace(/'/g, "\\'")}');" style="padding: 12px; cursor: pointer; border-bottom: 1px solid #e5e5e7; transition: background 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">
            <div style="font-weight: 600; font-size: 14px; color: #002366;">${p.nombre}</div>
            <div style="font-size: 12px; color: #666; margin-top: 2px;">
                ${p.cedula ? `📋 ${p.cedula}` : ''} ${p.telefono ? `📱 ${p.telefono}` : ''}
            </div>
        </div>
    `).join('');

    suggestions.style.display = 'block';
}

function seleccionarPacienteFactura(nombre) {
    const input = document.getElementById('pacienteNombre');
    input.value = nombre;
    input.dataset.pacienteSeleccionado = 'true'; // Marcar que se seleccionó de la lista
    document.getElementById('pacienteNombreSuggestions').style.display = 'none';

    // Guardar ID del paciente para vinculación correcta
    const pac = appData.pacientes.find(p => p.nombre === nombre);
    input.dataset.pacienteId = pac ? pac.id : '';
}

// ========================================
// SISTEMA DE CONSENTIMIENTO INFORMADO
// ========================================

let currentPacienteConsentimiento = null;
let signaturePad = null;

function abrirConsentimiento(pacienteId) {
    const paciente = appData.pacientes.find(p => p.id === pacienteId);
    if (!paciente) return;

    currentPacienteConsentimiento = paciente;

    document.getElementById('consentimientoNombre').textContent = paciente.nombre;
    document.getElementById('consentimientoCedula').textContent = paciente.cedula || 'No registrada';

    // Abrir modal primero
    openModal('modalConsentimiento');

    // Inicializar canvas DESPUÉS de que el modal esté visible (importante para dimensiones correctas)
    setTimeout(() => {
        const canvas = document.getElementById('signatureCanvas');
        const ctx = canvas.getContext('2d');

        // Establecer dimensiones explícitas
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;

        // Limpiar canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;

        let isDrawing = false;
        let lastX = 0;
        let lastY = 0;

        // Event listeners para dibujar
        canvas.onmousedown = (e) => {
            isDrawing = true;
            const rect = canvas.getBoundingClientRect();
            lastX = e.clientX - rect.left;
            lastY = e.clientY - rect.top;
        };

        canvas.onmousemove = (e) => {
            if (!isDrawing) return;
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            ctx.beginPath();
            ctx.moveTo(lastX, lastY);
            ctx.lineTo(x, y);
            ctx.stroke();

            lastX = x;
            lastY = y;
        };

        canvas.onmouseup = () => { isDrawing = false; };
        canvas.onmouseleave = () => { isDrawing = false; };

        // Touch events para móvil
        canvas.ontouchstart = (e) => {
            e.preventDefault();
            isDrawing = true;
            const rect = canvas.getBoundingClientRect();
            const touch = e.touches[0];
            lastX = touch.clientX - rect.left;
            lastY = touch.clientY - rect.top;
        };

        canvas.ontouchmove = (e) => {
            e.preventDefault();
            if (!isDrawing) return;
            const rect = canvas.getBoundingClientRect();
            const touch = e.touches[0];
            const x = touch.clientX - rect.left;
            const y = touch.clientY - rect.top;

            ctx.beginPath();
            ctx.moveTo(lastX, lastY);
            ctx.lineTo(x, y);
            ctx.stroke();
            lastX = x;
            lastY = y;
        };

        canvas.ontouchend = () => { isDrawing = false; };
    }, 100); // 100ms para que el modal se renderice completamente
}

function limpiarFirma() {
    const canvas = document.getElementById('signatureCanvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

async function guardarConsentimiento() {
    if (!currentPacienteConsentimiento) return;

    const canvas = document.getElementById('signatureCanvas');
    const ctx = canvas.getContext('2d');

    // Verificar que hay firma
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hasSignature = imageData.data.some(channel => channel !== 0);

    if (!hasSignature) {
        alert('Por favor firme el consentimiento');
        return;
    }

    // Guardar firma como base64
    const firmaBase64 = canvas.toDataURL('image/png');

    currentPacienteConsentimiento.consentimiento = {
        firmado: true,
        fecha: new Date().toISOString(),
        firmaBase64: firmaBase64
    };

    await saveData();
    closeModal('modalConsentimiento');
    updatePacientesTab();

    alert('✅ Consentimiento informado guardado exitosamente');
}

function verFirma(pacienteId) {
    const paciente = appData.pacientes.find(p => p.id === pacienteId);
    if (!paciente || !paciente.consentimiento || !paciente.consentimiento.firmado) {
        alert('Este paciente no tiene consentimiento firmado');
        return;
    }

    generarPDFConsentimiento(paciente);
}

function generarPDFConsentimiento(paciente) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    const pageWidth = doc.internal.pageSize.width;
    const pageHeight = doc.internal.pageSize.height;
    const margin = 20;
    let y = margin;

    // ============================================
    // HEADER - DATOS DE LA CLÍNICA
    // ============================================

    // Logo/Nombre de la clínica
    doc.setFillColor(0, 35, 102); // #002366
    doc.rect(0, 0, pageWidth, 35, 'F');

    // LOGO (si tienes logo.jpg, agrégalo aquí)
    // Ejemplo: doc.addImage(logoBase64, 'JPEG', 15, 5, 25, 25);

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(24);
    doc.setFont('helvetica', 'bold');
    doc.text(getNombreClinica(), pageWidth / 2, 15, { align: 'center' });

    doc.setFontSize(12);
    doc.setFont('helvetica', 'normal');
    doc.text(getNombreAdmin(), pageWidth / 2, 25, { align: 'center' });

    y = 45;

    // ============================================
    // TÍTULO DEL DOCUMENTO
    // ============================================

    doc.setTextColor(0, 35, 102);
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text('CONSENTIMIENTO INFORMADO', pageWidth / 2, y, { align: 'center' });

    y += 15;

    // ============================================
    // DATOS DEL PACIENTE
    // ============================================

    doc.setFillColor(248, 249, 250);
    doc.roundedRect(margin, y, pageWidth - 2 * margin, 35, 3, 3, 'F');

    doc.setTextColor(102, 102, 102);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('DATOS DEL PACIENTE', margin + 5, y + 8);

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(11);

    doc.text(`Nombre completo: ${paciente.nombre}`, margin + 5, y + 16);
    doc.text(`Cédula: ${paciente.cedula || 'No registrada'}`, margin + 5, y + 23);
    doc.text(`Teléfono: ${paciente.telefono || 'No registrado'}`, margin + 5, y + 30);

    y += 45;

    // ============================================
    // TEXTO DEL CONSENTIMIENTO
    // ============================================

    doc.setDrawColor(0, 122, 255);
    doc.setLineWidth(0.5);
    doc.rect(margin, y, pageWidth - 2 * margin, 80, 'S');

    doc.setTextColor(0, 35, 102);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('DECLARACIÓN DE CONSENTIMIENTO', margin + 5, y + 8);

    doc.setTextColor(51, 51, 51);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');

    const texto = `Por la presente, declaro que he sido informado de forma clara sobre el diagnóstico,
los riesgos, beneficios y alternativas del tratamiento dental propuesto. Autorizo
voluntariamente al personal de esta clínica a realizar los procedimientos necesarios,
incluyendo la administración de anestesia local si se requiere.

Comprendo que la medicina y odontología no son ciencias exactas y no se pueden
garantizar resultados específicos, asumiendo mi responsabilidad en el cumplimiento de
las indicaciones post-operatorias y asistencias a citas de control.

He tenido la oportunidad de hacer preguntas y todas mis dudas han sido resueltas
satisfactoriamente. Firmo este documento de forma libre y voluntaria.`;

    const lineas = doc.splitTextToSize(texto, pageWidth - 2 * margin - 10);
    doc.text(lineas, margin + 5, y + 16);

    y += 90;

    // ============================================
    // FIRMA DEL PACIENTE
    // ============================================

    doc.setDrawColor(221, 221, 221);
    doc.setLineWidth(0.3);
    doc.rect(margin, y, pageWidth - 2 * margin, 50, 'S');

    doc.setTextColor(102, 102, 102);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('FIRMA DEL PACIENTE (O TUTOR LEGAL)', margin + 5, y + 8);

    // Agregar imagen de la firma
    const firmaImg = paciente.consentimiento.firmaBase64;
    doc.addImage(firmaImg, 'PNG', margin + 10, y + 12, 80, 30);

    // Línea para la firma
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.5);
    doc.line(margin + 10, y + 43, margin + 90, y + 43);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(102, 102, 102);
    doc.text('Firma del paciente', margin + 35, y + 47);

    y += 60;

    // ============================================
    // FECHA Y HORA DE FIRMA
    // ============================================

    const fechaFirma = new Date(paciente.consentimiento.fecha);
    const fechaFormateada = fechaFirma.toLocaleDateString('es-DO', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    const horaFormateada = fechaFirma.toLocaleTimeString('es-DO', {
        hour: '2-digit',
        minute: '2-digit'
    });

    doc.setFillColor(212, 237, 218);
    doc.roundedRect(margin, y, pageWidth - 2 * margin, 20, 3, 3, 'F');

    doc.setTextColor(21, 87, 36);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('✓ DOCUMENTO FIRMADO DIGITALMENTE', margin + 5, y + 8);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`Fecha: ${fechaFormateada}`, margin + 5, y + 14);
    doc.text(`Hora: ${horaFormateada}`, margin + 5, y + 18);

    // ============================================
    // FOOTER
    // ============================================

    doc.setFontSize(8);
    doc.setTextColor(153, 153, 153);
    doc.setFont('helvetica', 'italic');
    doc.text(
        'Este documento es válido y tiene el mismo valor legal que un documento firmado en papel.',
        pageWidth / 2,
        pageHeight - 15,
        { align: 'center' }
    );

    doc.setFontSize(7);
    doc.text(
        `Generado el ${new Date().toLocaleDateString('es-DO')} a las ${new Date().toLocaleTimeString('es-DO')}`,
        pageWidth / 2,
        pageHeight - 10,
        { align: 'center' }
    );

    // ============================================
    // DESCARGAR PDF
    // ============================================

    const nombreArchivo = `Consentimiento_${paciente.nombre.replace(/\s+/g, '_')}_${fechaFirma.toISOString().split('T')[0]}.pdf`;
    doc.save(nombreArchivo);

    // Mostrar mensaje de éxito
    setTimeout(() => {
        alert(`✅ PDF descargado exitosamente:\n\n"${nombreArchivo}"`);
    }, 100);
}

// ========================================
// FUNCIÓN DE MIGRACIÓN/LIMPIEZA DE DATOS
// ========================================

async function limpiarDatosAntiguos() {
    let cambios = 0;

    // Corregir tipos de personal antiguos
    appData.personal.forEach(p => {
        if (p.tipo === 'profesional') {
            p.tipo = 'regular';
            cambios++;
        }
    });

    // Inicializar estados en citas sin estado
    appData.citas.forEach(c => {
        if (!c.estado) {
            c.estado = 'Pendiente';
            cambios++;
        }
    });

    if (cambios > 0) {
        await saveData();
        updateProfessionalPicker();
        updateReceptionPicker();
    }

    // Actualizar pickers siempre
    updateProfessionalPicker();
    updateReceptionPicker();
}

// ========================================
// GALERÍA DE PLACAS RADIOGRÁFICAS
// ========================================

let currentPacienteGaleria = null;

function abrirGaleriaPlacas(pacienteId) {
    const paciente = appData.pacientes.find(p => p.id === pacienteId);
    if (!paciente) return;

    currentPacienteGaleria = paciente;

    // Inicializar galería si no existe
    if (!paciente.placas) {
        paciente.placas = [];
    }

    document.getElementById('galeriaPacienteNombre').textContent = paciente.nombre;
    renderizarGaleriaPlacas();

    closeModal('modalVerPaciente');
    openModal('modalGaleriaPlacas');
}

function renderizarGaleriaPlacas() {
    if (!currentPacienteGaleria) return;

    const placas = currentPacienteGaleria.placas || [];
    const galeriaContainer = document.getElementById('galeriaPlacasContainer');

    if (placas.length === 0) {
        galeriaContainer.innerHTML = `
            <div style="text-align: center; padding: 60px 20px; color: #999;">
                <div style="font-size: 64px; margin-bottom: 20px;">🦷</div>
                <div style="font-size: 18px; font-weight: 600; margin-bottom: 10px;">Sin placas radiográficas</div>
                <div style="font-size: 14px;">Haz click en "Subir Nueva Placa" para agregar imágenes</div>
            </div>
        `;
        return;
    }

    // Ordenar por fecha (más reciente primero)
    const placasOrdenadas = [...placas].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    galeriaContainer.innerHTML = placasOrdenadas.map(placa => {
        // Soportar tanto base64 (legacy) como URL (nuevo)
        const imageSrc = placa.imageURL || placa.imagenBase64;

        return `
        <div class="placa-card" style="background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); transition: transform 0.2s;" onmouseover="this.style.transform='translateY(-4px)'" onmouseout="this.style.transform='translateY(0)'">
            <div style="position: relative; cursor: pointer;" onclick="verPlacaFullscreen('${placa.id}')">
                <img src="${imageSrc}" style="width: 100%; height: 200px; object-fit: cover; display: block;">
                <div style="position: absolute; top: 10px; right: 10px; background: rgba(0,0,0,0.7); color: white; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600;">
                    ${formatDate(placa.fecha)}
                </div>
            </div>
            <div style="padding: 15px;">
                <div style="font-size: 14px; font-weight: 600; color: #002366; margin-bottom: 8px;">${placa.tipo || 'Radiografía'}</div>
                ${placa.subidoPor ? `
                    <div style="font-size: 11px; color: #999; margin-bottom: 8px;">
                        👤 ${placa.subidoPor}
                    </div>
                ` : ''}
                ${placa.notas ? `
                    <div style="font-size: 13px; color: #666; margin-bottom: 10px; line-height: 1.4;">
                        ${placa.notas.length > 80 ? placa.notas.substring(0, 80) + '...' : placa.notas}
                    </div>
                ` : ''}
                <div style="display: flex; gap: 8px; margin-top: 12px;">
                    <button class="btn btn-secondary" onclick="editarPlaca('${placa.id}')" style="flex: 1; font-size: 12px; padding: 8px;">
                        ✏️ Editar
                    </button>
                    <button class="btn btn-cancel" onclick="eliminarPlaca('${placa.id}')" style="flex: 1; font-size: 12px; padding: 8px;">
                        🗑️ Eliminar
                    </button>
                </div>
            </div>
        </div>
        `;
    }).join('');
}

function abrirSubirPlaca() {
    document.getElementById('placaTipo').value = 'Periapical';
    document.getElementById('placaNotas').value = '';
    document.getElementById('placaInput').value = '';
    document.getElementById('placaPreview').src = '';
    document.getElementById('placaPreview').classList.add('hidden');
    document.getElementById('placaNombreArchivo').textContent = '';

    openModal('modalSubirPlaca');
}

function previsualizarPlaca() {
    const input = document.getElementById('placaInput');
    const preview = document.getElementById('placaPreview');
    const nombreArchivo = document.getElementById('placaNombreArchivo');

    if (input.files && input.files[0]) {
        const file = input.files[0];

        // Mostrar nombre del archivo
        nombreArchivo.innerHTML = `
            <div style="background: #e8f5e9; padding: 10px; border-radius: 6px; border: 1px solid #4caf50;">
                <span style="color: #2e7d32; font-weight: 600;">✓</span>
                <span style="color: #2e7d32;">${file.name}</span>
                <span style="color: #666; font-size: 11px; margin-left: 8px;">(${(file.size / 1024).toFixed(0)} KB)</span>
            </div>
        `;

        // Mostrar preview de la imagen
        const reader = new FileReader();
        reader.onload = function(e) {
            preview.src = e.target.result;
            preview.classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    } else {
        nombreArchivo.textContent = '';
        preview.classList.add('hidden');
    }
}

async function guardarPlaca() {
    const tipo = document.getElementById('placaTipo').value;
    const notas = document.getElementById('placaNotas').value.trim();
    const input = document.getElementById('placaInput');

    if (!input.files || !input.files[0]) {
        alert('Por favor selecciona una imagen');
        return;
    }

    const file = input.files[0];

    // Validar tamaño (máximo 5MB)
    if (file.size > 5 * 1024 * 1024) {
        alert('❌ La imagen es demasiado grande. Máximo 5MB.');
        return;
    }

    // Validar tipo
    if (!file.type.startsWith('image/')) {
        alert('❌ Solo se permiten imágenes.');
        return;
    }

    try {
        // Mostrar loading
        const loadingMsg = document.createElement('div');
        loadingMsg.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,0.8); color: white; padding: 20px 40px; border-radius: 12px; z-index: 99999; font-size: 16px;';
        loadingMsg.textContent = '⏳ Subiendo imagen...';
        document.body.appendChild(loadingMsg);

        // Subir a Firebase Storage
        const placaId = generateId('PLACA-');
        const fileName = `placas/${currentPacienteGaleria.id}/${placaId}_${Date.now()}.${file.name.split('.').pop()}`;
        const storageRef = firebase.storage().ref(fileName);

        // Subir archivo
        await storageRef.put(file);

        // Obtener URL de descarga
        const downloadURL = await storageRef.getDownloadURL();

        // Crear objeto de placa
        const placa = {
            id: placaId,
            tipo,
            notas,
            imageURL: downloadURL,  // URL en lugar de base64
            storagePath: fileName,  // Guardar ruta para poder eliminar después
            fecha: new Date().toISOString(),
            subidoPor: appData.currentUser
        };

        if (!currentPacienteGaleria.placas) {
            currentPacienteGaleria.placas = [];
        }

        currentPacienteGaleria.placas.push(placa);

        await saveData();

        // Quitar loading
        document.body.removeChild(loadingMsg);

        closeModal('modalSubirPlaca');
        renderizarGaleriaPlacas();

        alert('✅ Placa radiográfica guardada exitosamente');
    } catch (error) {
        console.error('❌ Error completo:', error);
        console.error('Código de error:', error.code);
        console.error('Mensaje:', error.message);

        // Quitar loading si existe
        const loadingMsg = document.querySelector('div[style*="Subiendo imagen"]');
        if (loadingMsg && loadingMsg.parentNode) {
            loadingMsg.parentNode.removeChild(loadingMsg);
        }

        // Mensaje de error específico
        let mensaje = '❌ Error al subir la imagen.\n\n';

        if (error.code === 'storage/unauthorized') {
            mensaje += '⚠️ FIREBASE STORAGE NO ESTÁ CONFIGURADO\n\n';
            mensaje += 'Necesitas habilitar Storage en Firebase:\n';
            mensaje += '1. Ve a console.firebase.google.com\n';
            mensaje += '2. Storage → Get Started\n';
            mensaje += '3. Configurar reglas de seguridad\n\n';
            mensaje += 'Por ahora, voy a guardar la placa en modo legacy (base64).';

            // Fallback: guardar como base64 (modo legacy)
            const reader = new FileReader();
            reader.onload = async function(e) {
                const placa = {
                    id: generateId('PLACA-'),
                    tipo,
                    notas,
                    imagenBase64: e.target.result,  // Base64 legacy
                    fecha: new Date().toISOString(),
                    subidoPor: appData.currentUser
                };

                if (!currentPacienteGaleria.placas) {
                    currentPacienteGaleria.placas = [];
                }

                currentPacienteGaleria.placas.push(placa);
                await saveData();

                closeModal('modalSubirPlaca');
                renderizarGaleriaPlacas();

                alert('⚠️ Placa guardada en modo legacy (base64).\n\nPara mejores resultados, configura Firebase Storage.');
            };
            reader.readAsDataURL(input.files[0]);

        } else if (error.code === 'storage/unknown') {
            mensaje += 'Firebase Storage no está habilitado.\n';
            mensaje += 'Ve a Firebase Console y habilita Storage.';
        } else {
            mensaje += 'Detalles: ' + error.message;
        }

        alert(mensaje);
    }
}

function verPlacaFullscreen(placaId) {
    if (!currentPacienteGaleria) return;

    const placa = currentPacienteGaleria.placas.find(p => p.id === placaId);
    if (!placa) return;

    // Soportar tanto base64 (legacy) como URL (nuevo)
    const imageSrc = placa.imageURL || placa.imagenBase64;

    document.getElementById('fullscreenPlacaImagen').src = imageSrc;
    document.getElementById('fullscreenPlacaTipo').textContent = placa.tipo || 'Radiografía';
    document.getElementById('fullscreenPlacaFecha').textContent = formatDate(placa.fecha);
    document.getElementById('fullscreenPlacaNotas').textContent = placa.notas || 'Sin notas';

    openModal('modalPlacaFullscreen');
}

function editarPlaca(placaId) {
    if (!currentPacienteGaleria) return;

    const placa = currentPacienteGaleria.placas.find(p => p.id === placaId);
    if (!placa) return;

    document.getElementById('editPlacaId').value = placaId;
    document.getElementById('editPlacaTipo').value = placa.tipo || 'Periapical';
    document.getElementById('editPlacaNotas').value = placa.notas || '';

    openModal('modalEditarPlaca');
}

async function guardarEdicionPlaca() {
    const placaId = document.getElementById('editPlacaId').value;
    const nuevoTipo = document.getElementById('editPlacaTipo').value;
    const nuevasNotas = document.getElementById('editPlacaNotas').value.trim();

    if (!currentPacienteGaleria) return;

    const placa = currentPacienteGaleria.placas.find(p => p.id === placaId);
    if (!placa) return;

    placa.tipo = nuevoTipo;
    placa.notas = nuevasNotas;
    placa.ultimaModificacion = new Date().toISOString();
    placa.modificadoPor = appData.currentUser;

    await saveData();

    closeModal('modalEditarPlaca');
    renderizarGaleriaPlacas();

    alert('✅ Placa actualizada exitosamente');
}

async function eliminarPlaca(placaId) {
    if (!currentPacienteGaleria) return;

    const placa = currentPacienteGaleria.placas.find(p => p.id === placaId);
    if (!placa) return;

    const confirmacion = confirm(`¿Estás seguro de eliminar esta placa?\n\nTipo: ${placa.tipo}\nFecha: ${formatDate(placa.fecha)}\n\nEsta acción no se puede deshacer.`);

    if (!confirmacion) return;

    try {
        // Si la placa está en Storage (tiene storagePath), eliminarla
        if (placa.storagePath) {
            const storageRef = firebase.storage().ref(placa.storagePath);
            await storageRef.delete().catch(err => {
                console.warn('No se pudo eliminar de Storage (puede que ya esté eliminada):', err);
            });
        }

        // Eliminar de Firestore
        currentPacienteGaleria.placas = currentPacienteGaleria.placas.filter(p => p.id !== placaId);

        await saveData();
        renderizarGaleriaPlacas();

        alert('✅ Placa eliminada exitosamente');
    } catch (error) {
        console.error('Error al eliminar placa:', error);
        alert('❌ Error al eliminar la placa. Por favor intenta de nuevo.');
    }
}

function descargarPlaca() {
    const imagen = document.getElementById('fullscreenPlacaImagen');
    const tipo = document.getElementById('fullscreenPlacaTipo').textContent;
    const fecha = document.getElementById('fullscreenPlacaFecha').textContent;

    const link = document.createElement('a');
    link.href = imagen.src;
    link.download = `Placa_${currentPacienteGaleria.nombre.replace(/\s+/g, '_')}_${tipo}_${fecha.replace(/\//g, '-')}.png`;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    alert('✅ Placa descargada exitosamente');
}

// Asegurar que avanzarEstadoLab esté disponible globalmente
window.avanzarEstadoLab = avanzarEstadoLab;

// ========================================
// SISTEMA DE RECETAS MÉDICAS
// ========================================

let currentPacienteRecetas = null;

function abrirRecetasMedicas(pacienteId) {
    const paciente = appData.pacientes.find(p => p.id === pacienteId);
    if (!paciente) return;

    currentPacienteRecetas = paciente;

    // Inicializar recetas si no existe
    if (!paciente.recetas) {
        paciente.recetas = [];
    }

    document.getElementById('recetasPacienteNombre').textContent = paciente.nombre;
    renderizarRecetas();

    closeModal('modalVerPaciente');
    openModal('modalRecetasMedicas');
}

function renderizarRecetas() {
    if (!currentPacienteRecetas) return;

    const recetas = currentPacienteRecetas.recetas || [];
    const container = document.getElementById('listaRecetas');

    if (recetas.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 60px 20px; color: #999;">
                <div style="font-size: 64px; margin-bottom: 20px;">💊</div>
                <div style="font-size: 18px; font-weight: 600; margin-bottom: 10px;">Sin recetas médicas</div>
                <div style="font-size: 14px;">Haz click en "Nueva Receta" para crear una</div>
            </div>
        `;
        return;
    }

    // Ordenar por fecha (más reciente primero)
    const recetasOrdenadas = [...recetas].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    container.innerHTML = recetasOrdenadas.map(receta => `
        <div style="background: white; border-radius: 12px; padding: 16px; margin-bottom: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border-left: 4px solid #007AFF;">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
                <div>
                    <div style="font-size: 16px; font-weight: 700; color: #002366; margin-bottom: 4px;">${formatDate(receta.fecha)}</div>
                    <div style="font-size: 13px; color: #666;">${receta.profesional}</div>
                </div>
                <button class="btn btn-secondary" onclick="descargarRecetaPDF('${receta.id}')" style="background: #28a745; color: white; font-size: 12px; padding: 6px 12px;">
                    📄 PDF
                </button>
            </div>

            ${receta.diagnostico ? `
                <div style="background: #f8f9fa; padding: 10px; border-radius: 6px; margin-bottom: 10px;">
                    <div style="font-size: 11px; color: #666; font-weight: 600; margin-bottom: 4px;">DIAGNÓSTICO</div>
                    <div style="font-size: 13px; color: #333;">${receta.diagnostico}</div>
                </div>
            ` : ''}

            <div style="background: #e8f5e9; padding: 10px; border-radius: 6px;">
                <div style="font-size: 11px; color: #2e7d32; font-weight: 600; margin-bottom: 8px;">MEDICAMENTOS</div>
                ${receta.medicamentos.map(med => `
                    <div style="margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid #c8e6c9;">
                        <div style="font-weight: 600; font-size: 13px; color: #1b5e20;">💊 ${med.nombre}</div>
                        <div style="font-size: 12px; color: #666; margin-top: 2px;">${med.dosis} - ${med.frecuencia}</div>
                        ${med.duracion ? `<div style="font-size: 12px; color: #666;">Duración: ${med.duracion}</div>` : ''}
                    </div>
                `).join('')}
            </div>

            ${receta.indicaciones ? `
                <div style="background: #fff3e0; padding: 10px; border-radius: 6px; margin-top: 10px;">
                    <div style="font-size: 11px; color: #e65100; font-weight: 600; margin-bottom: 4px;">INDICACIONES</div>
                    <div style="font-size: 12px; color: #333; line-height: 1.5;">${receta.indicaciones}</div>
                </div>
            ` : ''}
        </div>
    `).join('');
}

function abrirNuevaReceta() {
    // VALIDACIÓN: Solo profesionales pueden crear recetas
    const usuarioActual = appData.personal.find(p => p.nombre === appData.currentUser);
    if (!usuarioActual || usuarioActual.tipo === 'empleado') {
        alert('❌ PERMISO DENEGADO\n\nSolo los profesionales médicos pueden crear recetas.\n\nContacta a un doctor para crear una receta.');
        return;
    }

    // Limpiar formulario
    document.getElementById('recetaDiagnostico').value = '';
    document.getElementById('recetaIndicaciones').value = '';
    medicamentosTemp = [];
    renderizarMedicamentosTemp();

    openModal('modalNuevaReceta');
}

let medicamentosTemp = [];

function agregarMedicamento() {
    const nombre = document.getElementById('medNombre').value.trim();
    const dosis = document.getElementById('medDosis').value.trim();
    const frecuencia = document.getElementById('medFrecuencia').value.trim();
    const duracion = document.getElementById('medDuracion').value.trim();

    if (!nombre || !dosis || !frecuencia) {
        alert('Completa nombre, dosis y frecuencia del medicamento');
        return;
    }

    medicamentosTemp.push({
        id: generateId('MED-'),
        nombre,
        dosis,
        frecuencia,
        duracion
    });

    // Limpiar campos
    document.getElementById('medNombre').value = '';
    document.getElementById('medDosis').value = '';
    document.getElementById('medFrecuencia').value = '';
    document.getElementById('medDuracion').value = '';

    renderizarMedicamentosTemp();
}

function renderizarMedicamentosTemp() {
    const container = document.getElementById('medicamentosListaTemp');

    if (medicamentosTemp.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 20px; color: #999; font-size: 13px;">No hay medicamentos agregados</div>';
        return;
    }

    container.innerHTML = medicamentosTemp.map(med => `
        <div style="background: #e8f5e9; padding: 10px; border-radius: 6px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: start;">
            <div style="flex: 1;">
                <div style="font-weight: 600; font-size: 14px; color: #1b5e20; margin-bottom: 4px;">💊 ${med.nombre}</div>
                <div style="font-size: 12px; color: #666;">${med.dosis} - ${med.frecuencia}</div>
                ${med.duracion ? `<div style="font-size: 12px; color: #666;">Duración: ${med.duracion}</div>` : ''}
            </div>
            <button class="btn btn-cancel" onclick="eliminarMedicamentoTemp('${med.id}')" style="font-size: 11px; padding: 4px 8px;">
                ✕
            </button>
        </div>
    `).join('');
}

function eliminarMedicamentoTemp(medId) {
    medicamentosTemp = medicamentosTemp.filter(m => m.id !== medId);
    renderizarMedicamentosTemp();
}

async function guardarReceta() {
    const diagnostico = document.getElementById('recetaDiagnostico').value.trim();
    const indicaciones = document.getElementById('recetaIndicaciones').value.trim();

    if (medicamentosTemp.length === 0) {
        alert('Debes agregar al menos un medicamento');
        return;
    }

    const receta = {
        id: generateId('REC-'),
        fecha: new Date().toISOString(),
        profesional: appData.currentUser,
        diagnostico,
        medicamentos: [...medicamentosTemp],
        indicaciones
    };

    if (!currentPacienteRecetas.recetas) {
        currentPacienteRecetas.recetas = [];
    }

    currentPacienteRecetas.recetas.push(receta);

    await saveData();

    closeModal('modalNuevaReceta');
    renderizarRecetas();

    alert('✅ Receta médica guardada exitosamente');
}

function descargarRecetaPDF(recetaId) {
    if (!currentPacienteRecetas) return;

    const receta = currentPacienteRecetas.recetas.find(r => r.id === recetaId);
    if (!receta) return;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    const pageWidth = doc.internal.pageSize.width;
    let y = 20;

    // HEADER
    doc.setFillColor(0, 35, 102);
    doc.rect(0, 0, pageWidth, 40, 'F');

    // LOGO (si tienes logo.jpg, agrégalo aquí)
    // Ejemplo: doc.addImage(logoBase64, 'JPEG', 15, 5, 30, 30);

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(24);
    doc.setFont('helvetica', 'bold');
    doc.text('RECETA MÉDICA', pageWidth / 2, 20, { align: 'center' });

    doc.setFontSize(12);
    doc.setFont('helvetica', 'normal');
    doc.text(getNombreClinica() + ' - ' + getNombreAdmin(), pageWidth / 2, 30, { align: 'center' });

    y = 50;

    // DATOS DEL PACIENTE
    doc.setFillColor(248, 249, 250);
    doc.roundedRect(20, y, pageWidth - 40, 30, 3, 3, 'F');

    doc.setTextColor(0, 0, 0);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('PACIENTE', 25, y + 10);

    doc.setFont('helvetica', 'normal');
    doc.text(`${currentPacienteRecetas.nombre}`, 25, y + 18);
    doc.text(`Fecha: ${formatDate(receta.fecha)}`, pageWidth - 25, y + 18, { align: 'right' });

    y += 40;

    // DIAGNÓSTICO
    if (receta.diagnostico) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('DIAGNÓSTICO:', 20, y);

        y += 8;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        const diagnosticoLines = doc.splitTextToSize(receta.diagnostico, pageWidth - 40);
        doc.text(diagnosticoLines, 20, y);

        y += (diagnosticoLines.length * 6) + 10;
    }

    // MEDICAMENTOS
    doc.setDrawColor(0, 122, 255);
    doc.setLineWidth(0.5);
    doc.rect(20, y, pageWidth - 40, receta.medicamentos.length * 25 + 15, 'S');

    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('Rp/', 25, y + 10);

    y += 15;

    receta.medicamentos.forEach((med, index) => {
        doc.setFont('helvetica', 'bold');
        doc.text(`${index + 1}. ${med.nombre}`, 25, y);

        y += 6;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.text(`   ${med.dosis}`, 25, y);

        y += 5;
        doc.text(`   ${med.frecuencia}`, 25, y);

        if (med.duracion) {
            y += 5;
            doc.text(`   Duración: ${med.duracion}`, 25, y);
        }

        y += 10;
    });

    y += 5;

    // INDICACIONES
    if (receta.indicaciones) {
        y += 10;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('INDICACIONES:', 20, y);

        y += 8;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        const indicacionesLines = doc.splitTextToSize(receta.indicaciones, pageWidth - 40);
        doc.text(indicacionesLines, 20, y);

        y += (indicacionesLines.length * 6);
    }

    // FIRMA
    y = doc.internal.pageSize.height - 45;
    doc.setLineWidth(0.5);
    doc.line(pageWidth / 2 - 30, y, pageWidth / 2 + 30, y);

    y += 5;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(`${receta.profesional}`, pageWidth / 2, y, { align: 'center' });

    // Buscar exequatur del profesional
    const profesional = appData.personal.find(p => p.nombre === receta.profesional);
    const exequatur = profesional && profesional.exequatur ? profesional.exequatur : '';

    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    if (exequatur) {
        doc.text(`Exequatur: ${exequatur}`, pageWidth / 2, y, { align: 'center' });
    } else {
        doc.text('Registro Médico', pageWidth / 2, y, { align: 'center' });
    }

    // Descargar
    const nombreArchivo = `Receta_${currentPacienteRecetas.nombre.replace(/\s+/g, '_')}_${formatDate(receta.fecha).replace(/\//g, '-')}.pdf`;
    doc.save(nombreArchivo);

    alert('✅ Receta descargada exitosamente');
}

// ========================================
// FUNCIÓN CENTRALIZADA DE BALANCE
// ========================================

// Helper: buscar facturas de un paciente por ID o nombre (compatibilidad hacia atrás)
function getFacturasDePaciente(paciente) {
    return appData.facturas.filter(f =>
        (f.pacienteId && f.pacienteId === paciente.id) ||
        f.paciente === paciente.nombre
    );
}

// Helper: buscar citas de un paciente por ID o nombre
function getCitasDePaciente(paciente) {
    return appData.citas.filter(c =>
        (c.pacienteId && c.pacienteId === paciente.id) ||
        c.paciente === paciente.nombre
    );
}

function calcularBalancePaciente(nombrePaciente) {
    const paciente = appData.pacientes.find(p => p.nombre === nombrePaciente);
    const facturasPaciente = paciente
        ? getFacturasDePaciente(paciente)
        : appData.facturas.filter(f => f.paciente === nombrePaciente);

    return facturasPaciente.reduce((sum, f) => {
        const totalPagado = (f.pagos || []).reduce((s, p) => s + p.monto, 0);
        return sum + (f.total - totalPagado);
    }, 0);
}

// ========================================
// SISTEMA DE AUDITORÍA
// ========================================

// Inicializar logs si no existen
if (!appData.auditLogs) {
    appData.auditLogs = [];
}

function registrarAuditoria(accion, tipo, detalles) {
    const log = {
        id: generateId('LOG-'),
        fecha: new Date().toISOString(),
        usuario: appData.currentUser,
        accion: accion, // 'eliminar', 'modificar', 'acceso'
        tipo: tipo, // 'paciente', 'factura', 'personal', 'dato_sensible'
        detalles: detalles
    };

    if (!appData.auditLogs) {
        appData.auditLogs = [];
    }

    appData.auditLogs.push(log);
    saveData();

    console.log('📝 Auditoría:', log);
}

function verAuditoria() {
    if (appData.currentRole !== 'admin') {
        alert('❌ ACCESO DENEGADO\n\nSolo administradores pueden ver el historial de auditoría.');
        return;
    }

    renderizarAuditoria();
    openModal('modalAuditoria');
}

function renderizarAuditoria() {
    const logs = appData.auditLogs || [];
    const container = document.getElementById('listaAuditoria');

    if (logs.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 60px 20px; color: #999;">
                <div style="font-size: 64px; margin-bottom: 20px;">📋</div>
                <div style="font-size: 18px; font-weight: 600; margin-bottom: 10px;">Sin registros de auditoría</div>
                <div style="font-size: 14px;">Las acciones importantes quedarán registradas aquí</div>
            </div>
        `;
        return;
    }

    // Ordenar por fecha (más reciente primero)
    const logsOrdenados = [...logs].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    // Agrupar por día
    const logsPorDia = {};
    logsOrdenados.forEach(log => {
        const dia = new Date(log.fecha).toLocaleDateString('es-DO', {year: 'numeric', month: 'long', day: 'numeric'});
        if (!logsPorDia[dia]) {
            logsPorDia[dia] = [];
        }
        logsPorDia[dia].push(log);
    });

    container.innerHTML = Object.entries(logsPorDia).map(([dia, logsDelDia]) => `
        <div style="margin-bottom: 30px;">
            <h3 style="font-size: 16px; color: #002366; margin-bottom: 12px; font-weight: 700; border-bottom: 2px solid #e5e5e7; padding-bottom: 8px;">
                ${dia}
            </h3>
            ${logsDelDia.map(log => {
                const icono = {
                    'eliminar': '🗑️',
                    'modificar': '✏️',
                    'acceso': '👁️'
                }[log.accion] || '📝';

                const color = {
                    'eliminar': '#ff3b30',
                    'modificar': '#ff9500',
                    'acceso': '#007AFF'
                }[log.accion] || '#666';

                return `
                    <div style="background: white; border-radius: 8px; padding: 14px; margin-bottom: 10px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); border-left: 4px solid ${color};">
                        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                            <div style="font-weight: 600; font-size: 14px; color: #002366;">
                                ${icono} ${log.accion.toUpperCase()} ${log.tipo}
                            </div>
                            <div style="font-size: 12px; color: #999;">
                                ${new Date(log.fecha).toLocaleTimeString('es-DO', {hour: '2-digit', minute: '2-digit'})}
                            </div>
                        </div>
                        <div style="font-size: 13px; color: #666; margin-bottom: 6px;">
                            <strong>Usuario:</strong> ${log.usuario}
                        </div>
                        <div style="font-size: 13px; color: #666; background: #f8f9fa; padding: 8px; border-radius: 4px;">
                            ${log.detalles}
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `).join('');
}

// ========================================
// FILTROS AVANZADOS
// ========================================

function aplicarFiltrosFacturas() {
    const fechaDesde = document.getElementById('filtroFechaDesde').value;
    const fechaHasta = document.getElementById('filtroFechaHasta').value;
    const estado = document.getElementById('filtroEstadoFactura').value;
    const pacienteBusqueda = document.getElementById('filtroPacienteFactura').value.toLowerCase();

    let facturasFiltradas = appData.facturas;

    // Filtro por fecha
    if (fechaDesde) {
        const desde = new Date(fechaDesde);
        desde.setHours(0, 0, 0, 0);
        facturasFiltradas = facturasFiltradas.filter(f => new Date(f.fecha) >= desde);
    }

    if (fechaHasta) {
        const hasta = new Date(fechaHasta);
        hasta.setHours(23, 59, 59, 999);
        facturasFiltradas = facturasFiltradas.filter(f => new Date(f.fecha) <= hasta);
    }

    // Filtro por estado
    if (estado !== 'todos') {
        facturasFiltradas = facturasFiltradas.filter(f => f.estado === estado);
    }

    // Filtro por paciente
    if (pacienteBusqueda) {
        facturasFiltradas = facturasFiltradas.filter(f =>
            f.paciente.toLowerCase().includes(pacienteBusqueda) ||
            f.numero.toLowerCase().includes(pacienteBusqueda)
        );
    }

    // Renderizar facturas filtradas
    const list = document.getElementById('facturasPendientes');
    if (facturasFiltradas.length === 0) {
        list.innerHTML = '<li style="text-align: center; color: #999;">No hay facturas que coincidan con los filtros</li>';
    } else {
        list.innerHTML = facturasFiltradas.map(f => {
            const balance = f.total - f.pagos.reduce((sum, p) => sum + p.monto, 0);
            const hasComprobante = f.pagos.some(p => p.comprobanteData);
            const hasPagos = f.pagos.length > 0;

            return `
                <li style="cursor: default;">
                    <div class="item-header">
                        <div>
                            <div style="font-size: 12px; color: #8e8e93;">${f.numero} - ${formatDate(f.fecha)}</div>
                            <div class="item-title">${f.paciente}</div>
                            <div style="font-size: 14px; color: ${f.estado === 'pagada' ? '#34c759' : f.estado === 'partial' ? '#007aff' : '#ff3b30'}; font-weight: 600;">
                                ${f.estado === 'pagada' ? '✅ Pagada' : f.estado === 'partial' ? `💰 Con Abono: ${formatCurrency(balance)} pendiente` : `Balance: ${formatCurrency(balance)}`}
                            </div>
                            <div style="font-size: 13px; color: #666; margin-top: 4px;">Total: ${formatCurrency(f.total)}</div>
                            ${hasComprobante ? '<div style="font-size: 12px; color: #007aff; margin-top: 4px;">📎 Tiene comprobante</div>' : ''}
                        </div>
                    </div>
                    ${f.estado !== 'pagada' ? `
                        <div style="margin-top: 10px; display: flex; gap: 10px; flex-wrap: wrap;">
                            <button class="btn btn-submit" style="flex: 1; padding: 10px; font-size: 14px; min-width: 120px;" onclick="event.stopPropagation(); openPagarFactura('${f.id}')">
                                💳 Cobrar
                            </button>
                            ${hasComprobante ? `
                                <button class="btn btn-secondary" style="padding: 10px; font-size: 14px;" onclick="event.stopPropagation(); verComprobantesFactura('${f.id}')">
                                    📎 Ver
                                </button>
                            ` : ''}
                            ${hasPagos ? `
                                <button class="btn" style="padding: 10px; font-size: 14px; background: #ff9500; color: white;" onclick="event.stopPropagation(); abrirReversarCobro('${f.id}')">
                                    🔄 Reversar
                                </button>
                            ` : ''}
                            ${appData.currentRole === 'admin' ? `
                                <button class="btn btn-danger" style="padding: 10px; font-size: 14px;" onclick="event.stopPropagation(); eliminarFactura('${f.id}')">
                                    🗑️ Eliminar
                                </button>
                            ` : ''}
                        </div>
                    ` : ''}
                </li>
            `;
        }).join('');
    }

    // Actualizar contador
    const pendientes = facturasFiltradas.filter(f => f.estado !== 'pagada');
    document.getElementById('pendientesCount').textContent = pendientes.length;
}

function limpiarFiltrosFacturas() {
    document.getElementById('filtroFechaDesde').value = '';
    document.getElementById('filtroFechaHasta').value = '';
    document.getElementById('filtroEstadoFactura').value = 'pendiente';
    document.getElementById('filtroPacienteFactura').value = '';
    updateCobrarTab();
}

function aplicarFiltrosCitas(citas) {
    const filtroEstado = document.getElementById('filtroEstadoCita')?.value || 'todos';
    const filtroProfesional = document.getElementById('filtroProfesionalCita')?.value || 'todos';
    const filtroPaciente = document.getElementById('filtroPacienteCita')?.value.toLowerCase() || '';

    let citasFiltradas = citas;

    // Filtro por estado
    if (filtroEstado !== 'todos') {
        citasFiltradas = citasFiltradas.filter(c => (c.estado || 'Pendiente') === filtroEstado);
    }

    // Filtro por profesional
    if (filtroProfesional !== 'todos') {
        citasFiltradas = citasFiltradas.filter(c => c.profesional === filtroProfesional);
    }

    // Filtro por paciente
    if (filtroPaciente) {
        citasFiltradas = citasFiltradas.filter(c => c.paciente.toLowerCase().includes(filtroPaciente));
    }

    return citasFiltradas;
}

function inicializarFiltrosProfesionales() {
    const select = document.getElementById('filtroProfesionalCita');
    if (!select) return;

    const profesionales = appData.personal.filter(p => p.tipo !== 'empleado');

    select.innerHTML = '<option value="todos">Todos</option>';
    profesionales.forEach(p => {
        select.innerHTML += `<option value="${p.nombre}">${p.nombre}</option>`;
    });
}

// ========================================
// EXPORTAR A EXCEL
// ========================================

function exportarFacturasExcel() {
    // Usar librería SheetJS que ya está disponible
    const XLSX = window.XLSX;
    if (!XLSX) {
        alert('Error: Librería de Excel no disponible');
        return;
    }

    // Obtener facturas filtradas
    const fechaDesde = document.getElementById('filtroFechaDesde').value;
    const fechaHasta = document.getElementById('filtroFechaHasta').value;
    const estado = document.getElementById('filtroEstadoFactura').value;

    let facturas = appData.facturas;

    if (fechaDesde) {
        const desde = new Date(fechaDesde);
        facturas = facturas.filter(f => new Date(f.fecha) >= desde);
    }
    if (fechaHasta) {
        const hasta = new Date(fechaHasta);
        facturas = facturas.filter(f => new Date(f.fecha) <= hasta);
    }
    if (estado !== 'todos') {
        facturas = facturas.filter(f => f.estado === estado);
    }

    // Preparar datos para Excel
    const datos = facturas.map(f => {
        const totalPagado = f.pagos.reduce((sum, p) => sum + p.monto, 0);
        const balance = f.total - totalPagado;

        return {
            'Número': f.numero,
            'Fecha': formatDateWithTimezone(f.fecha),
            'Paciente': f.paciente,
            'Profesional': f.profesional,
            'Procedimientos': f.procedimientos.map(p => p.descripcion).join(', '),
            'Subtotal': f.subtotal,
            'Descuento %': (f.descuento * 100).toFixed(0),
            'Total': f.total,
            'Pagado': totalPagado,
            'Balance': balance,
            'Estado': f.estado === 'pagada' ? 'Pagada' : 'Pendiente'
        };
    });

    // Crear hoja de cálculo
    const ws = XLSX.utils.json_to_sheet(datos);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Facturas");

    // Generar archivo
    const nombreArchivo = `Facturas_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(wb, nombreArchivo);

    alert('✅ Archivo Excel generado exitosamente');
}

function exportarCitasExcel() {
    const XLSX = window.XLSX;
    if (!XLSX) {
        alert('Error: Librería de Excel no disponible');
        return;
    }

    // Preparar datos
    const datos = appData.citas.map(c => ({
        'Fecha': formatDateWithTimezone(c.fecha),
        'Hora': c.hora,
        'Paciente': c.paciente,
        'Profesional': c.profesional,
        'Consultorio': c.consultorio,
        'Motivo': c.motivo,
        'Estado': c.estado || 'Pendiente',
        'Creado Por': c.creadoPor || '',
        'Tiene Factura': c.facturaId ? 'Sí' : 'No'
    }));

    const ws = XLSX.utils.json_to_sheet(datos);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Citas");

    const nombreArchivo = `Citas_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(wb, nombreArchivo);

    alert('✅ Archivo Excel generado exitosamente');
}

function exportarComisionesExcel() {
    const XLSX = window.XLSX;
    if (!XLSX) {
        alert('Error: Librería de Excel no disponible');
        return;
    }

    const profesionales = appData.personal.filter(p => p.tipo !== 'empleado');

    const datos = profesionales.map(p => {
        const comisionRate = getComisionRate(p.tipo);
        const comisionesAcum = calcularComisionesAcumuladas(p);

        return {
            'Nombre': p.nombre,
            'Tipo': getTipoLabel(p.tipo),
            'Tasa Comisión %': comisionRate,
            'Comisiones Acumuladas': comisionesAcum,
            'Último Pago': p.lastPaymentDate ? formatDateWithTimezone(p.lastPaymentDate) : 'Nunca'
        };
    });

    const ws = XLSX.utils.json_to_sheet(datos);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Comisiones");

    const nombreArchivo = `Comisiones_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(wb, nombreArchivo);

    alert('✅ Archivo Excel generado exitosamente');
}

function exportarCuadreExcel() {
    const XLSX = window.XLSX;
    if (!XLSX) {
        alert('Error: Librería de Excel no disponible');
        return;
    }

    const cuadres = Object.entries(appData.cuadresDiarios || {}).map(([timestamp, cuadre]) => ({
        'Fecha': formatDateWithTimezone(cuadre.fecha),
        'Efectivo Inicial': cuadre.efectivoInicial || 0,
        'Efectivo': cuadre.efectivo,
        'Tarjeta': cuadre.tarjeta,
        'Transferencia': cuadre.transferencia,
        'Total Ingresos': cuadre.totalIngresos,
        'Gastos': cuadre.gastos,
        'Gastos en Efectivo': cuadre.gastosEfectivo,
        'Balance': cuadre.balance,
        'Efectivo en Caja': cuadre.efectivoCaja
    })).sort((a, b) => new Date(b.Fecha) - new Date(a.Fecha));

    const ws = XLSX.utils.json_to_sheet(cuadres);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Cuadre de Caja");

    const nombreArchivo = `Cuadre_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(wb, nombreArchivo);

    alert('✅ Archivo Excel generado exitosamente');
}

// ========================================
// ZONA HORARIA
// ========================================

function guardarZonaHoraria() {
    const timezone = document.getElementById('timezoneSelect').value;

    if (!appData.settings) {
        appData.settings = {};
    }

    appData.settings.timezone = timezone;
    saveData();

    console.log('✅ Zona horaria guardada:', timezone);
    alert('✅ Zona horaria actualizada correctamente');
}

function getTimezone() {
    return (appData.settings && appData.settings.timezone) || 'America/Santo_Domingo';
}

function getNombreClinica() {
    return (appData.settings && appData.settings.nombreClinica) || 'Clínica Dental';
}

function getNombreAdmin() {
    // Buscar el admin real en personal
    const admin = appData.personal.find(p => p.isAdmin);
    return admin ? admin.nombre : (appData.settings && appData.settings.nombreAdmin) || 'Administrador';
}

// Formatear fecha con zona horaria configurada
function formatDateWithTimezone(dateString) {
    if (!dateString) return '';

    try {
        const date = new Date(dateString);
        const timezone = getTimezone();

        return date.toLocaleDateString('es-DO', {
            timeZone: timezone,
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    } catch (e) {
        return formatDate(dateString); // Fallback
    }
}

function formatDateTimeWithTimezone(dateString) {
    if (!dateString) return '';

    try {
        const date = new Date(dateString);
        const timezone = getTimezone();

        return date.toLocaleString('es-DO', {
            timeZone: timezone,
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return formatDate(dateString); // Fallback
    }
}

// ========================================
// DASHBOARD
// ========================================

function updateDashboardTab() {
    const today = new Date();
    const todayTimestamp = today.setHours(0,0,0,0);

    // Fecha
    document.getElementById('dashboardFecha').textContent = new Date().toLocaleDateString('es-DO', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    // INGRESOS HOY
    const pagosHoy = appData.facturas
        .flatMap(f => f.pagos)
        .filter(p => new Date(p.fecha).setHours(0,0,0,0) === todayTimestamp);
    const ingresosHoy = pagosHoy.reduce((sum, p) => sum + p.monto, 0);

    // Comparación con ayer
    const ayer = new Date(todayTimestamp - 24*60*60*1000);
    const ayerTimestamp = ayer.setHours(0,0,0,0);
    const pagosAyer = appData.facturas
        .flatMap(f => f.pagos)
        .filter(p => new Date(p.fecha).setHours(0,0,0,0) === ayerTimestamp);
    const ingresosAyer = pagosAyer.reduce((sum, p) => sum + p.monto, 0);

    document.getElementById('dashIngresosHoy').textContent = formatCurrency(ingresosHoy);
    if (ingresosAyer > 0) {
        const cambio = ((ingresosHoy - ingresosAyer) / ingresosAyer * 100).toFixed(0);
        const icono = cambio >= 0 ? '↑' : '↓';
        const color = cambio >= 0 ? '#fff' : '#ffcccc';
        document.getElementById('dashIngresosComparacion').innerHTML =
            `<span style="color: ${color}">${icono} ${Math.abs(cambio)}% vs ayer</span>`;
    } else {
        document.getElementById('dashIngresosComparacion').textContent = 'Primer día con ingresos';
    }

    // CITAS HOY
    const citasHoy = appData.citas.filter(c => {
        const fechaCita = new Date(c.fecha);
        fechaCita.setHours(0,0,0,0);
        return fechaCita.getTime() === todayTimestamp;
    });
    const citasPendientes = citasHoy.filter(c =>
        c.estado === 'Pendiente' || c.estado === 'Confirmada'
    ).length;

    document.getElementById('dashCitasHoy').textContent = citasHoy.length;
    document.getElementById('dashCitasPendientes').textContent =
        citasPendientes > 0 ? `${citasPendientes} pendientes` : 'Todas completadas';

    // POR COBRAR
    const facturasPendientes = appData.facturas.filter(f => f.estado !== 'pagada');
    const porCobrar = facturasPendientes.reduce((sum, f) => {
        const pagado = f.pagos.reduce((s, p) => s + p.monto, 0);
        return sum + (f.total - pagado);
    }, 0);

    document.getElementById('dashPorCobrar').textContent = formatCurrency(porCobrar);
    document.getElementById('dashFacturasPendientes').textContent =
        `${facturasPendientes.length} factura${facturasPendientes.length !== 1 ? 's' : ''}`;

    // LABORATORIO ACTIVO
    const labActivo = (appData.laboratorios || []).filter(o =>
        o.estadoActual !== 'Entregado'
    );
    const labPendiente = labActivo.filter(o =>
        o.estadoActual === 'Toma de impresión' || o.estadoActual === 'Enviado a laboratorio'
    ).length;

    document.getElementById('dashLabActivo').textContent = labActivo.length;
    document.getElementById('dashLabPendiente').textContent =
        labPendiente > 0 ? `${labPendiente} pendientes` : 'Todos en proceso';

    // ALERTAS
    const alertas = [];

    // Facturas viejas
    const hace30Dias = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const facturasViejas = facturasPendientes.filter(f =>
        new Date(f.fecha).getTime() < hace30Dias
    );
    if (facturasViejas.length > 0) {
        alertas.push(`${facturasViejas.length} factura${facturasViejas.length !== 1 ? 's' : ''} pendiente${facturasViejas.length !== 1 ? 's' : ''} de más de 30 días`);
    }

    // Pacientes sin consentimiento
    const pacientesSinConsentimiento = appData.pacientes.filter(p =>
        !p.consentimiento || !p.consentimiento.firmado
    );
    if (pacientesSinConsentimiento.length > 0 && pacientesSinConsentimiento.length <= 10) {
        alertas.push(`${pacientesSinConsentimiento.length} paciente${pacientesSinConsentimiento.length !== 1 ? 's' : ''} sin consentimiento firmado`);
    }

    // Próxima cita (en 1 hora)
    const enUnaHora = Date.now() + (60 * 60 * 1000);
    const citaProxima = appData.citas.find(c => {
        const fechaCita = new Date(c.fecha).getTime();
        return fechaCita > Date.now() && fechaCita <= enUnaHora &&
               (c.estado === 'Pendiente' || c.estado === 'Confirmada');
    });
    if (citaProxima) {
        const hora = new Date(citaProxima.fecha).toLocaleTimeString('es-DO', {hour: '2-digit', minute: '2-digit'});
        alertas.push(`Próxima cita ${hora}: ${citaProxima.paciente} (${citaProxima.estado})`);
    }

    // Mostrar alertas
    const alertasContainer = document.getElementById('dashboardAlertas');
    if (alertas.length > 0) {
        alertasContainer.style.display = 'block';
        document.getElementById('dashAlertasList').innerHTML = alertas.map(a => `<li>${a}</li>`).join('');
    } else {
        alertasContainer.style.display = 'none';
    }

    // AGENDA HOY
    const agendaHoy = citasHoy
        .sort((a, b) => new Date(a.fecha) - new Date(b.fecha))
        .slice(0, 5); // Mostrar solo primeras 5

    if (agendaHoy.length === 0) {
        document.getElementById('dashAgendaHoy').innerHTML =
            '<div style="text-align: center; padding: 40px; color: #999;">No hay citas programadas para hoy</div>';
    } else {
        document.getElementById('dashAgendaHoy').innerHTML = agendaHoy.map(c => {
            const hora = new Date(c.fecha).toLocaleTimeString('es-DO', {hour: '2-digit', minute: '2-digit'});
            const color = getColorEstadoCita(c.estado);
            const icono = getIconoEstadoCita(c.estado);

            return `
                <div style="display: flex; align-items: center; padding: 12px; margin-bottom: 8px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid ${color};">
                    <div style="flex: 1;">
                        <div style="font-weight: 600; font-size: 14px; color: #002366;">${hora} - ${c.paciente}</div>
                        <div style="font-size: 13px; color: #666; margin-top: 2px;">${c.motivo} • ${c.profesional}</div>
                    </div>
                    <div style="background: ${color}; color: white; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600;">
                        ${icono} ${c.estado}
                    </div>
                </div>
            `;
        }).join('');

        if (citasHoy.length > 5) {
            document.getElementById('dashAgendaHoy').innerHTML +=
                `<div style="text-align: center; padding: 10px; color: #666;">
                    Y ${citasHoy.length - 5} cita${citasHoy.length - 5 !== 1 ? 's' : ''} más...
                </div>`;
        }
    }
}

// ========================================
// CONFIRMACIONES INTELIGENTES
// ========================================

let accionConfirmacion = null;

function mostrarConfirmacion(opciones) {
    const {
        titulo,
        mensaje,
        tipo = 'normal', // 'peligro', 'advertencia', 'normal'
        confirmText = 'Confirmar',
        onConfirm
    } = opciones;

    // Configurar modal
    document.getElementById('confirmacionTitulo').textContent = titulo;
    document.getElementById('confirmacionMensaje').innerHTML = mensaje;

    const btn = document.getElementById('confirmacionBtnConfirmar');
    btn.textContent = confirmText;

    // Estilos según tipo
    const header = document.getElementById('confirmacionHeader');
    if (tipo === 'peligro') {
        btn.className = 'btn btn-danger';
        header.style.background = 'linear-gradient(135deg, #ff3b30 0%, #dc143c 100%)';
    } else if (tipo === 'advertencia') {
        btn.className = 'btn' ;
        btn.style.background = '#ff9500';
        btn.style.color = 'white';
        header.style.background = 'linear-gradient(135deg, #ff9500 0%, #ff6b00 100%)';
    } else {
        btn.className = 'btn btn-submit';
        header.style.background = 'linear-gradient(135deg, #007aff 0%, #0051d5 100%)';
    }

    // Guardar acción
    accionConfirmacion = onConfirm;

    openModal('modalConfirmacion');
}

function ejecutarConfirmacion() {
    if (accionConfirmacion) {
        accionConfirmacion();
    }
    cerrarConfirmacion();
}

function cerrarConfirmacion() {
    closeModal('modalConfirmacion');
    accionConfirmacion = null;
}

// ========================================
// BÚSQUEDA GLOBAL
// ========================================

function buscarGlobal() {
    const input = document.getElementById('busquedaGlobal');
    const query = input.value.toLowerCase().trim();
    const resultados = document.getElementById('resultadosBusqueda');

    if (query.length < 2) {
        resultados.style.display = 'none';
        return;
    }

    let html = '';
    let totalResultados = 0;

    // BUSCAR PACIENTES
    const pacientes = appData.pacientes.filter(p =>
        p.nombre.toLowerCase().includes(query) ||
        (p.cedula && p.cedula.includes(query)) ||
        (p.telefono && p.telefono.includes(query))
    ).slice(0, 5);

    if (pacientes.length > 0) {
        html += `
            <div style="padding: 12px 16px; background: #f8f9fa; border-bottom: 1px solid #e5e5e7; font-weight: 600; font-size: 13px; color: #666;">
                PACIENTES (${pacientes.length})
            </div>
        `;
        pacientes.forEach(p => {
            html += `
                <div onclick="irAPaciente('${p.id}')" style="padding: 12px 16px; cursor: pointer; border-bottom: 1px solid #f0f0f0; transition: background 0.2s;" onmouseover="this.style.background='#f8f9fa'" onmouseout="this.style.background='white'">
                    <div style="font-weight: 600; font-size: 14px; color: #002366; margin-bottom: 4px;">
                        ${p.nombre}
                    </div>
                    <div style="font-size: 12px; color: #666;">
                        ${p.cedula ? `📋 ${p.cedula}` : ''} ${p.telefono ? `📱 ${p.telefono}` : ''}
                    </div>
                </div>
            `;
        });
        totalResultados += pacientes.length;
    }

    // BUSCAR FACTURAS
    const facturas = appData.facturas.filter(f =>
        f.numero.toLowerCase().includes(query) ||
        f.paciente.toLowerCase().includes(query)
    ).slice(0, 5);

    if (facturas.length > 0) {
        html += `
            <div style="padding: 12px 16px; background: #f8f9fa; border-bottom: 1px solid #e5e5e7; font-weight: 600; font-size: 13px; color: #666;">
                FACTURAS (${facturas.length})
            </div>
        `;
        facturas.forEach(f => {
            const color = f.estado === 'pagada' ? '#34c759' : f.estado === 'partial' ? '#007aff' : '#ff9500';
            const estadoLabel = f.estado === 'pagada' ? 'Pagada' : f.estado === 'partial' ? 'Con Abono' : 'Pendiente';

            html += `
                <div onclick="irAFactura('${f.id}')" style="padding: 12px 16px; cursor: pointer; border-bottom: 1px solid #f0f0f0; transition: background 0.2s;" onmouseover="this.style.background='#f8f9fa'" onmouseout="this.style.background='white'">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                        <div style="font-weight: 600; font-size: 14px; color: #002366;">
                            ${f.numero} • ${f.paciente}
                        </div>
                        <div style="background: ${color}; color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">
                            ${estadoLabel}
                        </div>
                    </div>
                    <div style="font-size: 12px; color: #666;">
                        ${formatCurrency(f.total)} • ${new Date(f.fecha).toLocaleDateString('es-DO')}
                    </div>
                </div>
            `;
        });
        totalResultados += facturas.length;
    }

    // BUSCAR CITAS
    const citas = appData.citas.filter(c =>
        c.paciente.toLowerCase().includes(query) ||
        c.profesional.toLowerCase().includes(query)
    ).slice(0, 5);

    if (citas.length > 0) {
        html += `
            <div style="padding: 12px 16px; background: #f8f9fa; border-bottom: 1px solid #e5e5e7; font-weight: 600; font-size: 13px; color: #666;">
                CITAS (${citas.length})
            </div>
        `;
        citas.forEach(c => {
            const fechaCita = new Date(c.fecha);
            const hoy = new Date();
            hoy.setHours(0,0,0,0);
            const esPasada = fechaCita < hoy;
            const color = getColorEstadoCita(c.estado);

            html += `
                <div onclick="irACita('${c.id}')" style="padding: 12px 16px; cursor: pointer; border-bottom: 1px solid #f0f0f0; transition: background 0.2s; ${esPasada ? 'opacity: 0.6;' : ''}" onmouseover="this.style.background='#f8f9fa'" onmouseout="this.style.background='white'">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                        <div style="font-weight: 600; font-size: 14px; color: #002366;">
                            ${fechaCita.toLocaleDateString('es-DO')} ${fechaCita.toLocaleTimeString('es-DO', {hour: '2-digit', minute: '2-digit'})}
                        </div>
                        <div style="background: ${color}; color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">
                            ${c.estado}
                        </div>
                    </div>
                    <div style="font-size: 12px; color: #666;">
                        ${c.paciente} • ${c.motivo}
                    </div>
                </div>
            `;
        });
        totalResultados += citas.length;
    }

    // SIN RESULTADOS
    if (totalResultados === 0) {
        html = `
            <div style="padding: 40px; text-align: center; color: #999;">
                <div style="font-size: 48px; margin-bottom: 12px;">🔍</div>
                <div style="font-size: 14px;">No se encontraron resultados para "${query}"</div>
            </div>
        `;
    }

    resultados.innerHTML = html;
    resultados.style.display = 'block';
}

// Navegación desde búsqueda
function irAPaciente(id) {
    document.getElementById('busquedaGlobal').value = '';
    document.getElementById('resultadosBusqueda').style.display = 'none';
    showTab('pacientes');
    setTimeout(() => verPaciente(id), 100);
}

function irAFactura(id) {
    document.getElementById('busquedaGlobal').value = '';
    document.getElementById('resultadosBusqueda').style.display = 'none';
    const factura = appData.facturas.find(f => f.id === id);
    if (factura && factura.estado !== 'pagada') {
        showTab('cobrar');
        setTimeout(() => abrirPago(id), 100);
    } else {
        showTab('ingresos');
        alert(`Factura ${factura.numero} ya está pagada.\nPuedes verla en el tab Ingresos.`);
    }
}

function irACita(id) {
    document.getElementById('busquedaGlobal').value = '';
    document.getElementById('resultadosBusqueda').style.display = 'none';
    showTab('agenda');
    setTimeout(() => {
        const cita = appData.citas.find(c => c.id === id);
        if (cita) verDetalleCita(cita);
    }, 100);
}

// Cerrar búsqueda al hacer click fuera
document.addEventListener('click', function(e) {
    const busqueda = document.getElementById('busquedaGlobal');
    const resultados = document.getElementById('resultadosBusqueda');
    if (busqueda && resultados && !busqueda.contains(e.target) && !resultados.contains(e.target)) {
        resultados.style.display = 'none';
    }
});

// ========================================
// IMPORTAR PACIENTES DESDE CSV
// ========================================

let csvData = null;
let csvHeaders = [];

function procesarCSV() {
    const fileInput = document.getElementById('csvFileInput');
    const file = fileInput.files[0];

    if (!file) {
        alert('Por favor selecciona un archivo CSV primero');
        return;
    }

    if (!file.name.endsWith('.csv')) {
        alert('El archivo debe ser un CSV (.csv)');
        return;
    }

    // Mostrar nombre del archivo seleccionado
    const archivoDiv = document.getElementById('archivoSeleccionado');
    const nombreSpan = document.getElementById('nombreArchivo');
    if (archivoDiv && nombreSpan) {
        nombreSpan.textContent = file.name;
        archivoDiv.style.display = 'block';
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        const text = e.target.result;
        parsearCSV(text);
    };
    reader.onerror = function() {
        alert('Error al leer el archivo');
    };
    reader.readAsText(file);
}

function parsearCSV(text) {
    // Parsear CSV simple (maneja comas y saltos de línea)
    const lines = text.split('\n').filter(line => line.trim());

    if (lines.length < 1) {
        alert('El archivo CSV está vacío');
        return;
    }

    // Detectar si tiene headers (primera línea contiene texto descriptivo en minúsculas)
    const primeraLinea = lines[0].toLowerCase();
    const tieneHeaders = primeraLinea.includes('nombre') ||
                        primeraLinea.includes('apellido') ||
                        primeraLinea.includes('paciente') ||
                        primeraLinea.includes('telefono') ||
                        primeraLinea.includes('cedula');

    let startIndex = 0;

    if (tieneHeaders) {
        // CSV normal con headers
        csvHeaders = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
        startIndex = 1;
    } else {
        // CSV sin headers (como el de Hessy)
        // Detectar formato automáticamente
        const primeraFila = lines[0].split(',').map(v => v.trim().replace(/"/g, ''));

        if (primeraFila.length >= 10) {
            // Formato Hessy: Apellido, Nombre, Sexo, ?, Fecha1, Fecha2, Dirección, ?, Tel1, Tel2
            csvHeaders = ['Apellido', 'Nombre', 'Sexo', 'Col4', 'Fecha1', 'Fecha2', 'Dirección', 'Col8', 'Teléfono1', 'Teléfono2'];
        } else {
            // Asignar headers genéricos
            csvHeaders = primeraFila.map((_, i) => `Columna${i + 1}`);
        }
        startIndex = 0;
    }

    // Parsear datos
    csvData = [];
    for (let i = startIndex; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
        const row = {};
        csvHeaders.forEach((header, index) => {
            row[header] = values[index] || '';
        });
        csvData.push(row);
    }

    // Mostrar advertencia si es formato Hessy
    if (!tieneHeaders && csvData.length > 100) {
        alert(`✅ CSV detectado (${csvData.length} filas)\n\n` +
              `ℹ️ Formato detectado: Apellido + Nombre separados\n` +
              `Se combinarán automáticamente como "Nombre Apellido"`);
    }

    mostrarMapeoColumnas();
}

function mostrarMapeoColumnas() {
    document.getElementById('paso2-mapeo').style.display = 'block';

    const camposApp = [
        { key: 'nombre', label: 'Nombre *', required: true },
        { key: 'telefono', label: 'Teléfono *', required: true },
        { key: 'cedula', label: 'Cédula' },
        { key: 'email', label: 'Email' },
        { key: 'fechaNacimiento', label: 'Fecha de Nacimiento' },
        { key: 'sexo', label: 'Sexo (M/F)' },
        { key: 'grupoSanguineo', label: 'Grupo Sanguíneo' },
        { key: 'direccion', label: 'Dirección' },
        { key: 'alergias', label: 'Alergias' },
        { key: 'condicionesMedicas', label: 'Condiciones Médicas' },
        { key: 'seguroMedico', label: 'Seguro Médico' },
        { key: 'contactoEmergenciaNombre', label: 'Contacto Emergencia - Nombre' },
        { key: 'contactoEmergenciaTelefono', label: 'Contacto Emergencia - Teléfono' }
    ];

    let html = '';

    // Banner explicativo si hay Apellido y Nombre separados
    if (csvHeaders.includes('Apellido') && csvHeaders.includes('Nombre')) {
        html += `
            <div style="background: linear-gradient(135deg, #34c759 0%, #30d158 100%); padding: 15px; border-radius: 8px; margin-bottom: 20px; color: white;">
                <div style="font-size: 16px; font-weight: 600; margin-bottom: 5px;">✓ Formato Detectado Automáticamente</div>
                <div style="font-size: 13px; opacity: 0.95;">
                    Tu CSV tiene Apellido y Nombre en columnas separadas. Se combinarán como <strong>"Nombre Apellido"</strong> automáticamente.
                </div>
            </div>
        `;
    }

    html += '<div style="display: grid; gap: 15px;">';

    camposApp.forEach(campo => {
        html += `
            <div style="display: grid; grid-template-columns: 200px 1fr; gap: 15px; align-items: center; padding: 12px; background: white; border: 1px solid #e5e5e7; border-radius: 8px;">
                <div style="font-weight: 600; color: #002366;">
                    ${campo.label}
                </div>
                <select id="map-${campo.key}" style="padding: 8px; border: 1px solid #e5e5e7; border-radius: 6px;">
                    <option value="">-- No importar --</option>
                    ${csvHeaders.map(h => `<option value="${h}">${h}</option>`).join('')}
                </select>
            </div>
        `;
    });

    html += '</div>';
    html += `
        <button class="btn btn-submit" onclick="generarVistaPrevia()" style="margin-top: 20px; width: 100%;">
            Ver Vista Previa →
        </button>
    `;

    document.getElementById('mapeoColumnas').innerHTML = html;

    // Auto-mapear columnas similares
    autoMapearColumnas(camposApp);
}

function autoMapearColumnas(camposApp) {
    camposApp.forEach(campo => {
        const select = document.getElementById(`map-${campo.key}`);
        if (!select) return;

        // CASO ESPECIAL: Nombre completo desde Apellido + Nombre separados
        if (campo.key === 'nombre') {
            if (csvHeaders.includes('Apellido') && csvHeaders.includes('Nombre')) {
                // Usar APELLIDO como señal para combinar (se manejará especialmente en generarVistaPrevia)
                select.value = 'Apellido';
                // Agregar nota explicativa
                setTimeout(() => {
                    const selectParent = select.parentElement;
                    if (selectParent && !document.getElementById('notaNombreCompleto')) {
                        const nota = document.createElement('div');
                        nota.id = 'notaNombreCompleto';
                        nota.style.cssText = 'background: #e3f2fd; padding: 8px 12px; border-radius: 6px; margin-top: 8px; font-size: 12px; color: #0d47a1;';
                        nota.innerHTML = '✓ Se combinarán automáticamente <strong>Nombre + Apellido</strong> en un solo campo';
                        selectParent.appendChild(nota);
                    }
                }, 100);
                return;
            }
        }

        // CASO ESPECIAL: Teléfono (tomar el primero disponible)
        if (campo.key === 'telefono') {
            if (csvHeaders.includes('Teléfono1')) {
                select.value = 'Teléfono1';
                return;
            }
        }

        // CASO ESPECIAL: Sexo
        if (campo.key === 'sexo' && csvHeaders.includes('Sexo')) {
            select.value = 'Sexo';
            return;
        }

        // CASO ESPECIAL: Dirección
        if (campo.key === 'direccion' && csvHeaders.includes('Dirección')) {
            select.value = 'Dirección';
            return;
        }

        // Buscar coincidencia general en headers
        const coincidencia = csvHeaders.find(h =>
            h.toLowerCase().includes(campo.key.toLowerCase()) ||
            campo.key.toLowerCase().includes(h.toLowerCase())
        );

        if (coincidencia) {
            select.value = coincidencia;
        }
    });
}

function generarVistaPrevia() {
    // Obtener mapeo
    const mapeo = {
        nombre: document.getElementById('map-nombre').value,
        telefono: document.getElementById('map-telefono').value,
        cedula: document.getElementById('map-cedula').value,
        email: document.getElementById('map-email').value,
        fechaNacimiento: document.getElementById('map-fechaNacimiento').value,
        sexo: document.getElementById('map-sexo').value,
        grupoSanguineo: document.getElementById('map-grupoSanguineo').value,
        direccion: document.getElementById('map-direccion').value,
        alergias: document.getElementById('map-alergias').value,
        condicionesMedicas: document.getElementById('map-condicionesMedicas').value,
        seguroMedico: document.getElementById('map-seguroMedico').value,
        contactoEmergenciaNombre: document.getElementById('map-contactoEmergenciaNombre').value,
        contactoEmergenciaTelefono: document.getElementById('map-contactoEmergenciaTelefono').value
    };

    // Validar campos requeridos
    if (!mapeo.nombre || !mapeo.telefono) {
        alert('❌ Debes mapear al menos Nombre y Teléfono (campos obligatorios)');
        return;
    }

    // Transformar datos
    const pacientes = csvData.map(row => {
        // Combinar Apellido + Nombre si están separados
        let nombreCompleto = '';
        if (mapeo.nombre === 'Apellido' && csvHeaders.includes('Nombre')) {
            // Formato Hessy: Apellido, Nombre → Nombre Apellido
            const nombre = row['Nombre'] || '';
            const apellido = row['Apellido'] || '';
            nombreCompleto = `${nombre} ${apellido}`.trim();
        } else {
            nombreCompleto = row[mapeo.nombre] || '';
        }

        // Combinar teléfonos si hay 2
        let telefono = row[mapeo.telefono] || '';
        if (!telefono && csvHeaders.includes('Teléfono2')) {
            telefono = row['Teléfono2'] || '';
        }

        const paciente = {
            id: generateId('PAC-'),
            nombre: nombreCompleto,
            telefono: telefono,
            cedula: row[mapeo.cedula] || '',
            email: row[mapeo.email] || '',
            fechaNacimiento: row[mapeo.fechaNacimiento] || '',
            sexo: row[mapeo.sexo] || '',
            grupoSanguineo: row[mapeo.grupoSanguineo] || '',
            direccion: row[mapeo.direccion] || '',
            alergias: row[mapeo.alergias] || '',
            condicionesMedicas: row[mapeo.condicionesMedicas] || '',
            seguroMedico: row[mapeo.seguroMedico] || '',
            contactoEmergencia: {
                nombre: row[mapeo.contactoEmergenciaNombre] || '',
                telefono: row[mapeo.contactoEmergenciaTelefono] || ''
            },
            consentimiento: {
                firmado: false
            },
            fechaRegistro: new Date().toISOString()
        };
        return paciente;
    });

    // Filtrar solo pacientes con nombre y teléfono
    const totalAntesFiltro = pacientes.length;
    window.pacientesAImportar = pacientes.filter(p => p.nombre && p.telefono);
    const totalDespuesFiltro = window.pacientesAImportar.length;
    const filtrados = totalAntesFiltro - totalDespuesFiltro;

    console.log(`📊 Procesamiento CSV:
    - Total filas: ${csvData.length}
    - Pacientes creados: ${totalAntesFiltro}
    - Con nombre y teléfono: ${totalDespuesFiltro}
    - Filtrados (sin datos): ${filtrados}`);

    // Mostrar vista previa
    document.getElementById('paso3-preview').style.display = 'block';
    document.getElementById('paso4-importar').style.display = 'block';

    let html = `
        <div style="background: #e3f2fd; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
            <div style="font-weight: 600; color: #0d47a1; margin-bottom: 8px;">
                ✅ Se importarán ${window.pacientesAImportar.length} pacientes
            </div>
            <div style="font-size: 13px; color: #1565c0;">
                Los primeros 5 se muestran a continuación para revisión
            </div>
            ${filtrados > 0 ? `<div style="font-size: 12px; color: #ff9500; margin-top: 5px;">⚠️ ${filtrados} filas fueron excluidas por no tener nombre o teléfono</div>` : ''}
        </div>
        <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                    <tr style="background: #f8f9fa;">
                        <th style="padding: 10px; text-align: left; border: 1px solid #e5e5e7;">Nombre</th>
                        <th style="padding: 10px; text-align: left; border: 1px solid #e5e5e7;">Teléfono</th>
                        <th style="padding: 10px; text-align: left; border: 1px solid #e5e5e7;">Cédula</th>
                        <th style="padding: 10px; text-align: left; border: 1px solid #e5e5e7;">Email</th>
                    </tr>
                </thead>
                <tbody>
    `;

    window.pacientesAImportar.slice(0, 5).forEach(p => {
        html += `
            <tr>
                <td style="padding: 10px; border: 1px solid #e5e5e7;">${p.nombre}</td>
                <td style="padding: 10px; border: 1px solid #e5e5e7;">${p.telefono}</td>
                <td style="padding: 10px; border: 1px solid #e5e5e7;">${p.cedula || '-'}</td>
                <td style="padding: 10px; border: 1px solid #e5e5e7;">${p.email || '-'}</td>
            </tr>
        `;
    });

    html += '</tbody></table></div>';

    if (window.pacientesAImportar.length > 5) {
        html += `<div style="text-align: center; padding: 10px; color: #666; font-size: 13px;">... y ${window.pacientesAImportar.length - 5} más</div>`;
    }

    document.getElementById('vistaPrevia').innerHTML = html;
}

function ejecutarImportacion() {
    if (!window.pacientesAImportar || window.pacientesAImportar.length === 0) {
        alert('No hay pacientes para importar');
        return;
    }

    mostrarConfirmacion({
        titulo: '📥 Importar Pacientes',
        mensaje: `
            <div style="text-align: center; padding: 20px;">
                <div style="font-size: 48px; margin-bottom: 15px;">📥</div>
                <div style="font-size: 18px; font-weight: 600; color: #002366; margin-bottom: 10px;">
                    ¿Confirmar importación de ${window.pacientesAImportar.length} pacientes?
                </div>
                <div style="font-size: 14px; color: #666;">
                    Los pacientes se agregarán a la base de datos actual
                </div>
            </div>
        `,
        tipo: 'normal',
        confirmText: 'Sí, Importar Ahora',
        onConfirm: async () => {
            console.log(`🚀 Iniciando importación de ${window.pacientesAImportar.length} pacientes...`);

            // Agregar pacientes
            const cantidadAntes = appData.pacientes.length;
            appData.pacientes.push(...window.pacientesAImportar);
            const cantidadDespues = appData.pacientes.length;

            console.log(`📥 Importación: ${cantidadAntes} → ${cantidadDespues} pacientes`);
            console.log(`✅ Pacientes agregados a appData correctamente`);
            console.log(`💾 Llamando a saveData()...`);

            await saveData();

            console.log(`✅ saveData() completado`);
            console.log(`🔄 Actualizando tab de pacientes...`);

            // Actualizar tab de pacientes para reflejar los nuevos
            updatePacientesTab();

            console.log(`✅ Tab actualizado. Mostrando mensaje de éxito...`);

            // Mostrar resultado
            document.getElementById('resultadoImportacion').style.display = 'block';
            document.getElementById('resultadoImportacion').innerHTML = `
                <div style="background: #d4edda; border: 1px solid #c3e6cb; padding: 20px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 48px; margin-bottom: 15px;">✅</div>
                    <div style="font-size: 20px; font-weight: 600; color: #155724; margin-bottom: 10px;">
                        ¡Importación Exitosa!
                    </div>
                    <div style="font-size: 16px; color: #155724; margin-bottom: 15px;">
                        ${window.pacientesAImportar.length} pacientes importados correctamente
                    </div>
                    <div style="font-size: 14px; color: #155724; margin-bottom: 15px;">
                        Total de pacientes en sistema: ${cantidadDespues}
                    </div>
                    <button class="btn btn-submit" onclick="showTab('pacientes')" style="margin-top: 10px; width: 100%;">
                        Ver Pacientes →
                    </button>
                </div>
            `;

            // Limpiar
            document.getElementById('csvFileInput').value = '';
            document.getElementById('paso2-mapeo').style.display = 'none';
            document.getElementById('paso3-preview').style.display = 'none';
            document.getElementById('paso4-importar').style.display = 'none';
            window.pacientesAImportar = null;

            updatePacientesTab();
        }
    });
}

// Editar paciente desde ficha
function editarPacienteActual() {
    if (!currentPacienteId) return;

    const paciente = appData.pacientes.find(p => p.id === currentPacienteId);
    if (!paciente) return;

    // Prellenar formulario
    document.getElementById('editPacienteNombre').value = paciente.nombre || '';
    document.getElementById('editPacienteTelefono').value = paciente.telefono || '';
    document.getElementById('editPacienteCedula').value = paciente.cedula || '';
    document.getElementById('editPacienteEmail').value = paciente.email || '';
    document.getElementById('editPacienteFechaNac').value = paciente.fechaNacimiento || '';
    document.getElementById('editPacienteSexo').value = paciente.sexo || '';
    document.getElementById('editPacienteGrupoSang').value = paciente.grupoSanguineo || '';
    document.getElementById('editPacienteDireccion').value = paciente.direccion || '';
    document.getElementById('editPacienteAlergias').value = paciente.alergias || '';
    document.getElementById('editPacienteCondiciones').value = paciente.condicionesMedicas || '';
    document.getElementById('editPacienteSeguro').value = paciente.seguroMedico || '';
    document.getElementById('editPacienteContactoNombre').value = (paciente.contactoEmergencia && paciente.contactoEmergencia.nombre) || '';
    document.getElementById('editPacienteContactoTel').value = (paciente.contactoEmergencia && paciente.contactoEmergencia.telefono) || '';

    // Cambiar de modal
    closeModal('modalVerPaciente');
    openModal('modalEditarPaciente');
}

function guardarEdicionPaciente() {
    if (!currentPacienteId) return;

    const paciente = appData.pacientes.find(p => p.id === currentPacienteId);
    if (!paciente) return;

    // Actualizar datos
    paciente.nombre = document.getElementById('editPacienteNombre').value.trim();
    paciente.telefono = document.getElementById('editPacienteTelefono').value.trim();
    paciente.cedula = document.getElementById('editPacienteCedula').value.trim();
    paciente.email = document.getElementById('editPacienteEmail').value.trim();
    paciente.fechaNacimiento = document.getElementById('editPacienteFechaNac').value;
    paciente.sexo = document.getElementById('editPacienteSexo').value;
    paciente.grupoSanguineo = document.getElementById('editPacienteGrupoSang').value.trim();
    paciente.direccion = document.getElementById('editPacienteDireccion').value.trim();
    paciente.alergias = document.getElementById('editPacienteAlergias').value.trim();
    paciente.condicionesMedicas = document.getElementById('editPacienteCondiciones').value.trim();
    paciente.seguroMedico = document.getElementById('editPacienteSeguro').value.trim();

    if (!paciente.contactoEmergencia) paciente.contactoEmergencia = {};
    paciente.contactoEmergencia.nombre = document.getElementById('editPacienteContactoNombre').value.trim();
    paciente.contactoEmergencia.telefono = document.getElementById('editPacienteContactoTel').value.trim();

    // Validar campos requeridos
    if (!paciente.nombre || !paciente.telefono) {
        alert('Nombre y teléfono son obligatorios');
        return;
    }

    saveData();
    updatePacientesTab();
    closeModal('modalEditarPaciente');

    alert('✅ Paciente actualizado correctamente');

    // Volver a abrir ficha actualizada
    verPaciente(currentPacienteId);
}

// Variable global para guardar cita actual en detalle
let currentCitaIdDetalle = null;


// Cancelar cita desde modal detalle
function cancelarCita() {
    if (!currentCitaIdDetalle) {
        alert('No se puede identificar la cita');
        return;
    }
    
    const cita = appData.citas.find(c => c.id === currentCitaIdDetalle);
    if (!cita) {
        alert('Cita no encontrada');
        return;
    }
    
    mostrarConfirmacion({
        titulo: '❌ Cancelar Cita',
        mensaje: `
            <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                <div style="font-size: 16px; font-weight: 600; color: #002366; margin-bottom: 8px;">
                    ${cita.paciente}
                </div>
                <div style="font-size: 14px; color: #666; margin-bottom: 4px;">
                    <strong>Fecha:</strong> ${formatDate(cita.fecha)} ${cita.hora}
                </div>
                <div style="font-size: 14px; color: #666; margin-bottom: 4px;">
                    <strong>Profesional:</strong> ${cita.profesional}
                </div>
                <div style="font-size: 14px; color: #666;">
                    <strong>Motivo:</strong> ${cita.motivo}
                </div>
            </div>
            <div style="background: #fff3cd; padding: 12px; border-radius: 6px; border-left: 3px solid #ffc107;">
                <div style="color: #856404; font-size: 13px;">
                    ⚠️ La cita se marcará como <strong>Cancelada</strong>
                </div>
            </div>
        `,
        tipo: 'advertencia',
        confirmText: 'Sí, Cancelar Cita',
        onConfirm: () => {
            cita.estado = 'Cancelada';
            saveData();
            closeModal('modalDetalleCita');
            updateAgendaTab();
            alert('✅ Cita cancelada');
        }
    });
}


// Abrir modal de abono desde ficha del paciente
function abrirAbonoBalance(pacienteId) {
    // VALIDAR PERMISO: Solo admin y recepción pueden cobrar
    if (appData.currentRole === 'professional') {
        alert('⛔ Acceso Denegado\n\nLos profesionales no tienen permiso para realizar cobros.\nContacta a recepción o administración.');
        return;
    }
    
    const paciente = appData.pacientes.find(p => p.id === pacienteId);
    if (!paciente) {
        console.error('Paciente no encontrado:', pacienteId);
        return;
    }
    
    console.log('📊 Debug abrirAbonoBalance:');
    console.log('Paciente:', paciente.nombre);
    
    const todasFacturas = getFacturasDePaciente(paciente);
    console.log('Total facturas del paciente:', todasFacturas.length);
    console.log('Estados de facturas:', todasFacturas.map(f => ({ numero: f.numero, estado: f.estado })));
    
    // Encontrar factura más antigua pendiente (filtro robusto - ambos idiomas)
    const facturasPendientes = todasFacturas
        .filter(f => {
            const estado = (f.estado || '').toLowerCase().trim();
            return estado === 'pendiente' || 
                   estado === 'parcial' || 
                   estado === 'pending' || 
                   estado === 'partial';
        })
        .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    
    console.log('Facturas pendientes encontradas:', facturasPendientes.length);
    
    if (facturasPendientes.length === 0) {
        alert('No hay facturas pendientes para este paciente.\n\nRevisa la consola (F12) para más detalles.');
        return;
    }
    
    console.log('Abriendo pago de factura:', facturasPendientes[0].numero);
    
    // Abrir pago de la factura más antigua
    closeModal('modalVerPaciente');
    abrirPagoFactura(facturasPendientes[0].id, pacienteId);
}

// Abrir pago de factura desde ficha del paciente
function abrirPagoFactura(facturaId, pacienteId) {
    // VALIDAR PERMISO: Solo admin y recepción pueden cobrar
    if (appData.currentRole === 'professional') {
        alert('⛔ Acceso Denegado\n\nLos profesionales no tienen permiso para realizar cobros.\nContacta a recepción o administración.');
        return;
    }
    
    closeModal('modalVerPaciente');
    openPagarFactura(facturaId);
    
    // Guardar pacienteId para volver a la ficha después
    window.tempPacienteIdRetorno = pacienteId;
}

