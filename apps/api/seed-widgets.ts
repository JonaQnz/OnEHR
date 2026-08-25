import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // 1. Körpergewicht (Weight)
  const weightAql = await prisma.aqlFunction.upsert({
    where: { packageName_name: { packageName: 'vitals', name: 'body-weight-history' } },
    update: {},
    create: {
      packageName: 'vitals',
      name: 'body-weight-history',
      description: 'Fetch the latest 50 body weight measurements.',
      query: `SELECT c/uid/value AS compositionUid, c/context/start_time/value AS time, w/data[at0002]/events[at0003]/data[at0001]/items[at0004]/value/magnitude AS weight FROM EHR ehr[ehr_id/value = :ehrId] CONTAINS COMPOSITION c CONTAINS OBSERVATION w[openEHR-EHR-OBSERVATION.body_weight.v2] WHERE c/archetype_details/template_id/value = 'Körpergewicht' ORDER BY c/context/start_time/value DESC LIMIT 50`,
      parameters: { ehrId: { required: true } },
      autoload: false,
      enabled: true
    }
  });

  await prisma.dataWidget.create({
    data: {
      name: 'Körpergewicht (Historie)',
      description: 'Gewichtsverlauf der letzten Messungen',
      aqlFunctionId: weightAql.id,
      configuration: {
        display: 'line',
        packageName: 'Vitals',
        valueColumn: 'weight',
        timeColumn: 'time',
        limit: 50,
        referenceRange: {
          min: 40,
          max: 120
        }
      }
    }
  });

  // 2. Körpergröße (Height)
  const heightAql = await prisma.aqlFunction.upsert({
    where: { packageName_name: { packageName: 'vitals', name: 'body-height-history' } },
    update: {},
    create: {
      packageName: 'vitals',
      name: 'body-height-history',
      description: 'Fetch the latest 50 body height measurements.',
      query: `SELECT c/uid/value AS compositionUid, c/context/start_time/value AS time, h/data[at0001]/events[at0002]/data[at0003]/items[at0004]/value/magnitude AS height FROM EHR ehr[ehr_id/value = :ehrId] CONTAINS COMPOSITION c CONTAINS OBSERVATION h[openEHR-EHR-OBSERVATION.height.v2] WHERE c/archetype_details/template_id/value = 'Körpergröße' ORDER BY c/context/start_time/value DESC LIMIT 50`,
      parameters: { ehrId: { required: true } },
      autoload: false,
      enabled: true
    }
  });

  await prisma.dataWidget.create({
    data: {
      name: 'Körpergröße (Historie)',
      description: 'Entwicklung der Körpergröße',
      aqlFunctionId: heightAql.id,
      configuration: {
        display: 'line',
        packageName: 'Vitals',
        valueColumn: 'height',
        timeColumn: 'time',
        limit: 50,
        referenceRange: {
          min: 150,
          max: 200
        }
      }
    }
  });

  // 3. BMI Calculation (BMI is usually calculated, but let's do Heart Rate instead since we saw bpm_vital_signs_patient, wait no, we saw openEHR-EHR-OBSERVATION.body_temperature.v2)
  // Let's do Body Temperature from bpm_vital_signs_patient
  const tempAql = await prisma.aqlFunction.upsert({
    where: { packageName_name: { packageName: 'vitals', name: 'body-temp-history' } },
    update: {},
    create: {
      packageName: 'vitals',
      name: 'body-temp-history',
      description: 'Fetch the latest 50 body temperature measurements.',
      query: `SELECT c/uid/value AS compositionUid, c/context/start_time/value AS time, t/data[at0002]/events[at0003]/data[at0001]/items[at0004]/value/magnitude AS temperature FROM EHR ehr[ehr_id/value = :ehrId] CONTAINS COMPOSITION c CONTAINS OBSERVATION t[openEHR-EHR-OBSERVATION.body_temperature.v2] WHERE c/archetype_details/template_id/value = 'bpm_vital_signs_patient' ORDER BY c/context/start_time/value DESC LIMIT 50`,
      parameters: { ehrId: { required: true } },
      autoload: false,
      enabled: true
    }
  });

  await prisma.dataWidget.create({
    data: {
      name: 'Körpertemperatur',
      description: 'Temperaturverlauf über die Zeit',
      aqlFunctionId: tempAql.id,
      configuration: {
        display: 'line',
        packageName: 'Vitals',
        valueColumn: 'temperature',
        timeColumn: 'time',
        limit: 50,
        referenceRange: {
          min: 36.5,
          max: 37.5
        }
      }
    }
  });

  console.log('Successfully created widgets!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
