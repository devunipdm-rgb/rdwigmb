const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// CORS para permitir acesso de arquivos locais
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Proxy para o Square Cloud
const squareProxy = createProxyMiddleware({
    target: 'https://rdwigmb.squareweb.app',
    changeOrigin: true,
    pathRewrite: {
        '^/api': '', // remove /api
    },
    onProxyReq: (proxyReq, req, res) => {
        // Adicionar headers CORS
        proxyReq.setHeader('Origin', 'https://rdwigmb.squareweb.app');
        console.log(`🌐 PROXY REQUEST: ${req.method} ${req.url} → https://rdwigmb.squareweb.app${req.url}`);
        if (req.body) {
            console.log(`📤 BODY:`, req.body);
        }
    },
    onProxyRes: (proxyRes, req, res) => {
        // Adicionar headers CORS na resposta
        proxyRes.headers['Access-Control-Allow-Origin'] = '*';
        proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        proxyRes.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Requested-With';
        console.log(`📥 PROXY RESPONSE: ${req.method} ${req.url} - Status: ${proxyRes.statusCode}`);
    }
});

// Middleware para log de todas as requisições
app.use((req, res, next) => {
    console.log(`📥 REQUEST RECEIVED: ${req.method} ${req.url}`);
    next();
});

// Middleware para parse JSON
app.use(express.json());

// Rotas do proxy (ANTES do static) - com path completo
app.use('/status', squareProxy);
app.use('/qrcode', squareProxy);
app.use('/disparar', squareProxy);

// Servir o HTML estático (APENAS para arquivos, não para APIs)
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/test-proxy.html');
});

app.use(express.static('.'));

const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Proxy server rodando na porta ${PORT}`);
    console.log(`📱 Acesse: http://localhost:${PORT}`);
    console.log(`🌐 Proxy para: https://rdwigmb.squareweb.app`);
});
