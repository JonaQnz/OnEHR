import express from 'express';
import cors from 'cors';
import { loadServerConfig } from './config';
import { loadFormsApiConfigFromEnv, FormsApiClient } from './formsApiClient';
import { createScenarioRoutes } from './routes/scenarios';
import { createPatientRoutes } from './routes/patients';

const config = loadServerConfig();
const api = new FormsApiClient(loadFormsApiConfigFromEnv());

const app = express();
app.use(cors({ origin: config.webOrigin, credentials: false }));
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/scenarios', createScenarioRoutes(api));
app.use('/api/patients', createPatientRoutes(api));

app.listen(config.port, () => {
  console.log(`vital-signs-generator backend listening on :${config.port}`);
});
