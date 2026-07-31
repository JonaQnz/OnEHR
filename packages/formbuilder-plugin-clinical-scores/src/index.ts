import type { FunctionPackageDefinition } from 'plugin-api';

const pkg: FunctionPackageDefinition = {
  id: 'clinical-scores',
  version: '1.0.0',
  functions: [
    {
      name: 'clinical.calculateBmi',
      description: 'Calculates Body Mass Index (BMI) from weight and height.',
      parameters: {
        weightKg: 'number',
        heightCm: 'number',
      },
      returns: 'number',
      execute: (params: { weightKg: number; heightCm: number }) => {
        if (!params.weightKg || !params.heightCm) return null;
        const bmi = params.weightKg / Math.pow(params.heightCm / 100, 2);
        return Math.round(bmi * 10) / 10;
      },
    },
    {
      name: 'clinical.calculateNews2',
      description: 'Calculates the National Early Warning Score (NEWS2) based on physiological parameters.',
      parameters: {
        respiratoryRate: 'number',
        spo2Scale1: 'number',
        spo2Scale2: 'number',
        airOrOxygen: 'string',
        systolicBloodPressure: 'number',
        pulse: 'number',
        consciousness: 'string',
        temperature: 'number'
      },
      returns: 'number',
      execute: (params: any) => {
        // Simplified baseline calculation for demonstration
        let score = 0;
        if (params.respiratoryRate <= 8 || params.respiratoryRate >= 25) score += 3;
        if (params.pulse <= 40 || params.pulse >= 131) score += 3;
        if (params.systolicBloodPressure <= 90 || params.systolicBloodPressure >= 220) score += 3;
        if (params.temperature <= 35.0) score += 3;
        if (params.consciousness && params.consciousness !== 'Alert') score += 3;
        if (params.airOrOxygen && params.airOrOxygen !== 'Air') score += 2;
        return score;
      }
    },
    {
      name: 'clinical.calculateQsofa',
      description: 'Calculates quick SOFA (qSOFA) score.',
      parameters: {
        respiratoryRate: 'number',
        systolicBloodPressure: 'number',
        alteredMentation: 'boolean'
      },
      returns: 'number',
      execute: (params: any) => {
        let score = 0;
        if (params.respiratoryRate >= 22) score += 1;
        if (params.systolicBloodPressure <= 100) score += 1;
        if (params.alteredMentation) score += 1;
        return score;
      }
    },
    {
      name: 'clinical.calculateSofa',
      description: 'Calculates SOFA score (Simplified version).',
      parameters: {
        pao2Fio2: 'number',
        platelets: 'number',
        bilirubin: 'number',
        meanArterialPressure: 'number',
        glasgowComaScale: 'number',
        creatinine: 'number'
      },
      returns: 'number',
      execute: (params: any) => {
        let score = 0;
        if (params.glasgowComaScale && params.glasgowComaScale < 15) {
          if (params.glasgowComaScale >= 13) score += 1;
          else if (params.glasgowComaScale >= 10) score += 2;
          else if (params.glasgowComaScale >= 6) score += 3;
          else score += 4;
        }
        return score;
      }
    },
    {
      name: 'clinical.calculateBarthel',
      description: 'Calculates Barthel Index of Activities of Daily Living.',
      parameters: {
        feeding: 'number',
        bathing: 'number',
        grooming: 'number',
        dressing: 'number',
        bowels: 'number',
        bladder: 'number',
        toiletUse: 'number',
        transfers: 'number',
        mobility: 'number',
        stairs: 'number'
      },
      returns: 'number',
      execute: (params: any) => {
        const p = params;
        return (p.feeding||0) + (p.bathing||0) + (p.grooming||0) + (p.dressing||0) + 
               (p.bowels||0) + (p.bladder||0) + (p.toiletUse||0) + (p.transfers||0) + 
               (p.mobility||0) + (p.stairs||0);
      }
    },
    {
      name: 'clinical.calculateGcs',
      description: 'Calculates Glasgow Coma Scale.',
      parameters: {
        eyeResponse: 'number',
        verbalResponse: 'number',
        motorResponse: 'number'
      },
      returns: 'number',
      execute: (params: any) => {
        return (params.eyeResponse || 0) + (params.verbalResponse || 0) + (params.motorResponse || 0);
      }
    },
    {
      name: 'clinical.calculateChads2Vasc',
      description: 'Calculates CHA2DS2-VASc score for atrial fibrillation stroke risk.',
      parameters: {
        age: 'number',
        sex: 'string', // 'male' or 'female'
        congestiveHeartFailure: 'boolean',
        hypertension: 'boolean',
        strokeTiaThromboembolism: 'boolean',
        vascularDisease: 'boolean',
        diabetesMellitus: 'boolean'
      },
      returns: 'number',
      execute: (params: any) => {
        let score = 0;
        if (params.congestiveHeartFailure) score += 1;
        if (params.hypertension) score += 1;
        if (params.age >= 75) score += 2;
        else if (params.age >= 65) score += 1;
        if (params.diabetesMellitus) score += 1;
        if (params.strokeTiaThromboembolism) score += 2;
        if (params.vascularDisease) score += 1;
        if (params.sex === 'female') score += 1;
        return score;
      }
    },
    {
      name: 'clinical.calculateHasBled',
      description: 'Calculates HAS-BLED score for bleeding risk.',
      parameters: {
        hypertension: 'boolean',
        abnormalRenal: 'boolean',
        abnormalLiver: 'boolean',
        stroke: 'boolean',
        bleeding: 'boolean',
        labileInr: 'boolean',
        elderly: 'boolean',
        drugs: 'boolean',
        alcohol: 'boolean'
      },
      returns: 'number',
      execute: (params: any) => {
        let score = 0;
        if (params.hypertension) score += 1;
        if (params.abnormalRenal) score += 1;
        if (params.abnormalLiver) score += 1;
        if (params.stroke) score += 1;
        if (params.bleeding) score += 1;
        if (params.labileInr) score += 1;
        if (params.elderly) score += 1;
        if (params.drugs) score += 1;
        if (params.alcohol) score += 1;
        return score;
      }
    },
    {
      name: 'clinical.calculateCockcroftGault',
      description: 'Calculates Creatinine Clearance (Cockcroft-Gault Equation).',
      parameters: {
        ageYears: 'number',
        weightKg: 'number',
        creatinineMgDl: 'number',
        sex: 'string' // 'male' or 'female'
      },
      returns: 'number',
      execute: (params: any) => {
        if (!params.ageYears || !params.weightKg || !params.creatinineMgDl) return null;
        let crcl = ((140 - params.ageYears) * params.weightKg) / (72 * params.creatinineMgDl);
        if (params.sex === 'female') {
          crcl = crcl * 0.85;
        }
        return Math.round(crcl * 10) / 10;
      }
    },
    {
      name: 'clinical.calculateEgfr',
      description: 'Calculates estimated Glomerular Filtration Rate (eGFR) using CKD-EPI equation.',
      parameters: {
        creatinineMgDl: 'number',
        ageYears: 'number',
        sex: 'string', // 'male' or 'female'
        race: 'string' // 'black' or 'other'
      },
      returns: 'number',
      execute: (params: any) => {
        if (!params.ageYears || !params.creatinineMgDl) return null;
        const isFemale = params.sex === 'female';
        const kappa = isFemale ? 0.7 : 0.9;
        const alpha = isFemale ? -0.329 : -0.411;
        const cr = params.creatinineMgDl / kappa;
        let egfr = 141 * Math.pow(Math.min(cr, 1), alpha) * Math.pow(Math.max(cr, 1), -1.209) * Math.pow(0.993, params.ageYears);
        if (isFemale) egfr *= 1.018;
        if (params.race === 'black') egfr *= 1.159;
        return Math.round(egfr);
      }
    }
  ]
};

export default pkg;
