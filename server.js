const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    delay 
} = require('@whiskeysockets/baileys');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode'); // Adicionado para gerar imagem para o front
const fs = require('fs');
require('dotenv').config();

// 1. CONFIGURAÇÃO FIREBASE ADMIN
let serviceAccount;
let db;

try {
    // Tentar carregar firebase-key.json primeiro (local)
    if (fs.existsSync('./firebase-key.json')) {
        serviceAccount = require("./firebase-key.json");
    } else if (process.env.FIREBASE_PROJECT_ID) {
        // Fallback para variáveis de ambiente (production)
        serviceAccount = {
            type: "service_account",
            project_id: process.env.FIREBASE_PROJECT_ID,
            private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
            private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
            client_id: process.env.FIREBASE_CLIENT_ID,
            auth_uri: process.env.FIREBASE_AUTH_URI || "https://accounts.google.com/o/oauth2/auth",
            token_uri: process.env.FIREBASE_TOKEN_URI || "https://oauth2.googleapis.com/token",
            auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL || "https://www.googleapis.com/oauth2/v1/certs",
            client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
        };
    } else {
        throw new Error("Credenciais Firebase não encontradas!");
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL || "https://igmbinstituto.firebaseio.com"
    });

    db = admin.firestore();
    console.log("✅ Firebase configurado com sucesso");
} catch (error) {
    console.error("❌ Erro ao configurar Firebase:", error.message);
    console.error("\n📝 Solução:");
    console.error("1. Baixe firebase-key.json do Console Firebase");
    console.error("2. Coloque na raiz do projeto ou configure variáveis de ambiente");
    console.error("3. Veja CONFIGURACAO.md para mais detalhes\n");
    process.exit(1);
}
const app = express();

// ============================================
// CORS - Usar package cors
// ============================================
app.use(cors({
    origin: ['https://rdwigmb.squareweb.app', 'null'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: false,
    preflightContinue: false,
    optionsSuccessStatus: 204
}));

// JSON parser
app.use(express.json());
app.use(express.static('.')); // Servir arquivos estáticos (HTML, CSS, JS)

let sock;
let isProcessing = false;
let lastQR = null;

// 2. FUNÇÃO PRINCIPAL DO WHATSAPP (BAILEYS)
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,  // Desabilitar QR no terminal
        browser: ["Whatsapp", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            lastQR = qr; // Armazena o QR Code para o endpoint
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            lastQR = null;
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            // Reconectar silenciosamente
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            lastQR = null;
            console.log('✅ WhatsApp conectado com sucesso!');
        }
    });

    // Ignorar erros de phash do Baileys (mensagem já foi entregue)
    sock.ev.on('message.update', (update) => {
        for (const [key, value] of Object.entries(update)) {
            // Silenciar erros de phash - mensagem já foi entregue
            if (value.status && value.status === 'ERROR') {
                // Log silencioso - mensagem foi entregue apesar do erro
            }
        }
    });

    return sock;
}

// 3. LÓGICA DE DISPARO COM CHECKPOINT NO FIRESTORE
async function startCampaign(campanhaId, listaContatos, mensagem) {
    if (isProcessing) return;
    isProcessing = true;

    console.log(`\n🚀 Campanha iniciada: ${campanhaId} | ${listaContatos.length} contatos`);

    let enviados = 0;
    let falhados = 0;

    for (let i = 0; i < listaContatos.length; i++) {
        const contato = listaContatos[i];
        let numeroLimpo = contato.replace(/\D/g, '');
        
        // Se não começar com +55 (Brasil), adicionar
        if (!numeroLimpo.startsWith('55')) {
            numeroLimpo = '55' + numeroLimpo;
        }
        
        // Validar formato do número
        if (numeroLimpo.length < 12 || numeroLimpo.length > 13) {
            console.error(`❌ [${i + 1}/${listaContatos.length}] ${contato} - Formato inválido (deve ter 11-12 dígitos + código de país)`);
            falhados++;
            continue;
        }

        const numeroWhatsApp = numeroLimpo + "@s.whatsapp.net";

        try {
            // Checkpoint: Verifica se já foi enviado para este contato nesta campanha
            const check = await db.collection('envios_concluidos')
                .where('contato', '==', contato)
                .where('id_campanha', '==', campanhaId)
                .get();

            if (!check.empty) {
                // Ignorar silenciosamente
                continue;
            }

            // Verificar se servidor WhatsApp está conectado
            if (!sock?.user) {
                throw new Error('WhatsApp desconectado');
            }

            // Envio com retry
            let tentativa = 1;
            let sucesso = false;
            
            while (tentativa <= 3 && !sucesso) {
                try {
                    // Log silencioso
                    
                    const result = await sock.sendMessage(numeroWhatsApp, { text: mensagem });
                    
                    enviados++; // Incrementar contador silenciosamente
                    sucesso = true;
                    enviados++;

                    // Registro de Sucesso no Firestore
                    await db.collection('envios_concluidos').add({
                        contato: contato,
                        id_campanha: campanhaId,
                        data: admin.firestore.FieldValue.serverTimestamp(),
                        status: 'sucesso',
                        messageId: result?.key?.id || 'unknown'
                    });

                } catch (error) {
                    const errorMsg = error.message || String(error);
                    
                    // Erros de phash significam que a mensagem FOI entregue
                    if (errorMsg.includes('phash') || errorMsg.includes('could not send message again')) {
                        // Entregue com sucesso
                        sucesso = true;
                        enviados++;
                        
                        // Registrar como sucesso
                        await db.collection('envios_concluidos').add({
                            contato: contato,
                            id_campanha: campanhaId,
                            data: admin.firestore.FieldValue.serverTimestamp(),
                            status: 'sucesso'
                        });
                    } else {
                        // Tentativa falhou, tentando novamente
                        tentativa++;
                        
                        if (tentativa <= 3) {
                            // Esperar 5 segundos antes de retentar
                            await delay(5000);
                        }
                    }
                }
            }

            if (!sucesso) {
                console.error(`❌ [${i + 1}/${listaContatos.length}] Falha ao enviar para ${contato} após 3 tentativas`);
                falhados++;
                
                // Registrar falha no Firestore
                await db.collection('envios_concluidos').add({
                    contato: contato,
                    id_campanha: campanhaId,
                    data: admin.firestore.FieldValue.serverTimestamp(),
                    status: 'falha'
                });
            }

            // Delay anti-ban (30 a 60 segundos entre mensagens)
            const tempoEspera = Math.floor(Math.random() * (60000 - 30000 + 1) + 30000);
                        // Aguardando antes do próximo
            await delay(tempoEspera);

        } catch (error) {
            console.error(`❌ Erro ao processar ${contato}:`, error.message);
            falhados++;
            
            if (error.message.includes('connection')) {
                console.error('❌ Conexão perdida. Interrompendo campanha.');
                isProcessing = false;
                break;
            }
        }
    }

    isProcessing = false;
    console.log(`✅ Campanha ${campanhaId} concluída: ${enviados}✓ | ${falhados}✗ | Total: ${listaContatos.length}`);
}

// 4. ENDPOINTS API

// Endpoint para o frontend buscar o QR Code como imagem
app.get('/qrcode', async (req, res) => {
    if (sock?.user) return res.json({ status: "Conectado", conectado: true });
    if (!lastQR) return res.status(404).json({ error: "QR Code ainda não gerado ou expirado" });
    
    try {
        const qrImage = await QRCode.toDataURL(lastQR);
        res.json({ qrcode: qrImage, conectado: false });
    } catch (err) {
        res.status(500).json({ error: "Erro ao gerar imagem do QR" });
    }
});

app.post('/disparar', async (req, res) => {
    const { campanhaId, contatos, mensagem } = req.body;
    
    // Validar dados
    if (!campanhaId || !contatos || !mensagem) {
        return res.status(400).json({ 
            error: "Faltam dados obrigatórios: campanhaId, contatos, mensagem" 
        });
    }

    if (!Array.isArray(contatos) || contatos.length === 0) {
        return res.status(400).json({ 
            error: "contatos deve ser um array com pelo menos um número" 
        });
    }

    if (typeof mensagem !== 'string' || mensagem.trim().length === 0) {
        return res.status(400).json({ 
            error: "mensagem deve ser uma string não vazia" 
        });
    }

    if (!sock?.user) {
        return res.status(503).json({ 
            error: "WhatsApp não está conectado. Escaneie o QR Code primeiro.",
            user: sock?.user || null
        });
    }

    if (isProcessing) {
        return res.status(429).json({ 
            error: "Uma campanha já está em processamento. Aguarde a conclusão." 
        });
    }

    // Iniciar campanha em background
    startCampaign(campanhaId, contatos, mensagem).catch(err => {
        console.error('Erro na campanha:', err);
    });

    return res.json({ 
        message: "✅ Campanha iniciada com sucesso!",
        status: "processing",
        campanhaId: campanhaId,
        contatoCount: contatos.length,
        info: "Acompanhe o progresso no terminal ou verifique no Firebase"
    });
});

app.get('/status', (req, res) => {
    res.json({ 
        conectado: !!(sock?.user),
        processando: isProcessing,
        numero: sock?.user?.id || null
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend rodando na porta ${PORT}`);
    connectToWhatsApp();
});