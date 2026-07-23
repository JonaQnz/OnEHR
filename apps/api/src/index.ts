import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { initConfig } from './services/configService';
import formRoutes from './routes/formRoutes';
import templateRoutes from './routes/templateRoutes';
import configRoutes from './routes/configRoutes';
import { errorHandler } from './middleware/errorHandler';

dotenv.config();
initConfig();

// Axios Logging Interceptors for Deep Debugging
axios.interceptors.request.use((config) => {
  const isAuth = config.headers?.Authorization ? 'Bearer [hidden]' : 'None';
  const hasBasic = config.auth ? `Basic [${config.auth.username}]` : 'None';
  console.log(`\n[AXIOS REQUEST] ${config.method?.toUpperCase()} ${config.url}`);
  console.log(`  Headers: ${JSON.stringify(config.headers)}`);
  console.log(`  Auth: Keycloak=${isAuth}, Basic=${hasBasic}`);
  return config;
}, (error) => {
  console.error(`[AXIOS REQUEST ERROR]`, error.message);
  return Promise.reject(error);
});

axios.interceptors.response.use((response) => {
  console.log(`[AXIOS RESPONSE] ${response.status} ${response.config.method?.toUpperCase()} ${response.config.url}`);
  console.log(`  Data: ${JSON.stringify(response.data).substring(0, 1000)}`);
  return response;
}, (error) => {
  if (error.response) {
    console.error(`[AXIOS ERROR RESPONSE] ${error.response.status} ${error.config?.method?.toUpperCase()} ${error.config?.url}`);
    console.error(`  Error Data: ${JSON.stringify(error.response.data)}`);
  } else {
    console.error(`[AXIOS NETWORK ERROR] ${error.config?.method?.toUpperCase()} ${error.config?.url} - ${error.message}`);
  }
  return Promise.reject(error);
});

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Incoming request logger middleware
app.use((req, res, next) => {
  console.log(`\n📥 [API INCOMING] ${req.method} ${req.url}`);
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/forms', formRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/config', configRoutes);

app.listen(port, () => {
  console.log(`API Server running at http://localhost:${port}`);
});
