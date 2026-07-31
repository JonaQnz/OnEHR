import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
import { initConfig } from './services/configService';
import formRoutes from './routes/formRoutes';
import templateRoutes from './routes/templateRoutes';
import configRoutes from './routes/configRoutes';
import { errorHandler } from './middleware/errorHandler';
import pluginRoutes from './routes/pluginRoutes';
import { loadConfiguredPlugins } from './plugins/pluginRegistry';
import authRoutes from './routes/authRoutes';
import { attachAuth } from './middleware/auth';
import formSessionRoutes from './routes/formSessionRoutes';
import dataProviderRoutes from './routes/dataProviderRoutes';
import patientRoutes from './routes/patientRoutes';
import scriptConnectorRoutes from './routes/scriptConnectorRoutes';
import formLaunchRoutes from './routes/formLaunchRoutes';

// Resolve the API-local environment file, independent of the process working
// directory (for example when started as `node apps/api/dist/index.js`).
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
initConfig();

// Axios Logging Interceptors for Deep Debugging
axios.interceptors.request.use((config) => {
  console.debug(`[HTTP REQUEST] ${config.method?.toUpperCase() || 'GET'}`);
  return config;
}, (error) => {
  console.error(`[AXIOS REQUEST ERROR]`, error.message);
  return Promise.reject(error);
});

axios.interceptors.response.use((response) => {
  console.debug(`[HTTP RESPONSE] ${response.status} ${response.config.method?.toUpperCase() || 'GET'}`);
  return response;
}, (error) => {
  if (error.response) {
    console.error(`[HTTP ERROR RESPONSE] ${error.response.status} ${error.config?.method?.toUpperCase() || 'GET'}`);
  } else {
    console.error(`[HTTP NETWORK ERROR] ${error.config?.method?.toUpperCase() || 'GET'} - ${error.message}`);
  }
  return Promise.reject(error);
});

const app = express();
const port = process.env.PORT || 3001;
app.use('/api', attachAuth);

app.use(cors({ origin: process.env.WEB_ORIGIN || 'http://localhost:3000', credentials: true }));
app.use(express.json());

// Incoming request logger middleware
app.use((req, res, next) => {
  console.log(`\n📥 [API INCOMING] ${req.method} ${req.url}`);
  next();
});

app.use('/api/auth', authRoutes);
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.use('/api/form-sessions', formSessionRoutes);
app.use('/api/form-launches', formLaunchRoutes);
app.use('/api/data-providers', dataProviderRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/script-connectors', scriptConnectorRoutes);

app.use('/api/forms', formRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/config', configRoutes);
app.use('/api/plugins', pluginRoutes);

app.use(errorHandler);

async function start() {
  await loadConfiguredPlugins();
  app.listen(port, () => {
    console.log(`API Server running at http://localhost:${port}`);
  });
}

void start().catch((error) => {
  console.error('[PLUGIN STARTUP ERROR]', error);
  process.exitCode = 1;
});
