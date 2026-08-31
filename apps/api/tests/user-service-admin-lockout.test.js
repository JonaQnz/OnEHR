const assert = require('node:assert/strict');
const test = require('node:test');
const prisma = require('../dist/db/prisma').default;
const { updateUser, setUserStatus, UserServiceError } = require('../dist/services/userService');

// QA review finding: nothing previously stopped an admin from
// deactivating their own account, or from demoting/deactivating the sole
// remaining active ADMIN (their own or someone else's) - a single
// misclick could lock the whole system out of user.manage with no
// recovery besides redeploying with FORMS_BOOTSTRAP_ADMIN_* env vars.

const original = {
  findUnique: prisma.applicationUser.findUnique,
  count: prisma.applicationUser.count,
  update: prisma.applicationUser.update,
  sessionUpdateMany: prisma.applicationSession.updateMany,
  auditCreate: prisma.auditEvent.create,
  transaction: prisma.$transaction,
};

/** `$transaction` in real Prisma hands the callback a client with the same
 * shape as `prisma` itself - mocking it as "just call back with prisma"
 * lets every test below mock applicationUser/applicationSession/auditEvent
 * directly on `prisma`, same as this repo's existing service tests do for
 * non-transactional calls. */
function installStore({ user, otherActiveAdmins }) {
  prisma.$transaction = async (fn) => fn(prisma);
  prisma.applicationUser.findUnique = async () => user;
  prisma.applicationUser.count = async () => otherActiveAdmins;
  prisma.applicationUser.update = async ({ data }) => ({ ...user, ...data, roles: data.roles ? data.roles.create.map((entry) => ({ role: entry.role })) : user?.roles || [] });
  prisma.applicationSession.updateMany = async () => ({ count: 0 });
  prisma.auditEvent.create = async () => ({});
  return {
    restore: () => {
      prisma.applicationUser.findUnique = original.findUnique;
      prisma.applicationUser.count = original.count;
      prisma.applicationUser.update = original.update;
      prisma.applicationSession.updateMany = original.sessionUpdateMany;
      prisma.auditEvent.create = original.auditCreate;
      prisma.$transaction = original.transaction;
    },
  };
}

test('updateUser: rejects removing ADMIN from the last remaining active administrator', async () => {
  const store = installStore({
    user: { id: 'admin-1', username: 'admin', displayName: null, email: null, status: 'active', passwordHash: null, roles: [{ role: 'ADMIN' }] },
    otherActiveAdmins: 0,
  });
  try {
    await assert.rejects(
      () => updateUser('admin-1', { roles: ['USER'] }, 'someone-else'),
      (error) => { assert.ok(error instanceof UserServiceError); assert.equal(error.status, 409); return true; },
    );
  } finally { store.restore(); }
});

test('updateUser: allows removing ADMIN when another active administrator remains', async () => {
  const store = installStore({
    user: { id: 'admin-1', username: 'admin', displayName: null, email: null, status: 'active', passwordHash: null, roles: [{ role: 'ADMIN' }] },
    otherActiveAdmins: 1,
  });
  try {
    const result = await updateUser('admin-1', { roles: ['USER'] }, 'someone-else');
    assert.deepEqual(result.roles, ['USER']);
  } finally { store.restore(); }
});

test('updateUser: a non-role update (e.g. displayName) never triggers the admin-lockout check, even for the last admin', async () => {
  const store = installStore({
    user: { id: 'admin-1', username: 'admin', displayName: null, email: null, status: 'active', passwordHash: null, roles: [{ role: 'ADMIN' }] },
    otherActiveAdmins: 0,
  });
  try {
    const result = await updateUser('admin-1', { displayName: 'New Name' }, 'admin-1');
    assert.equal(result.displayName, 'New Name');
  } finally { store.restore(); }
});

test('setUserStatus: rejects an admin deactivating their own account', async () => {
  const store = installStore({ user: null, otherActiveAdmins: 0 });
  try {
    await assert.rejects(
      () => setUserStatus('admin-1', false, 'admin-1'),
      (error) => { assert.ok(error instanceof UserServiceError); assert.equal(error.status, 400); return true; },
    );
  } finally { store.restore(); }
});

test('setUserStatus: rejects deactivating the last remaining active administrator, even by a different actor', async () => {
  const store = installStore({
    user: { id: 'admin-1', username: 'admin', displayName: null, email: null, status: 'active', passwordHash: null, roles: [{ role: 'ADMIN' }] },
    otherActiveAdmins: 0,
  });
  try {
    await assert.rejects(
      () => setUserStatus('admin-1', false, 'someone-else'),
      (error) => { assert.ok(error instanceof UserServiceError); assert.equal(error.status, 409); return true; },
    );
  } finally { store.restore(); }
});

test('setUserStatus: allows deactivating an admin when another active administrator remains', async () => {
  const store = installStore({
    user: { id: 'admin-1', username: 'admin', displayName: null, email: null, status: 'active', passwordHash: null, roles: [{ role: 'ADMIN' }] },
    otherActiveAdmins: 1,
  });
  try {
    const result = await setUserStatus('admin-1', false, 'someone-else');
    assert.equal(result.status, 'inactive');
  } finally { store.restore(); }
});

test('setUserStatus: allows deactivating a plain USER regardless of admin count', async () => {
  const store = installStore({
    user: { id: 'user-1', username: 'nurse', displayName: null, email: null, status: 'active', passwordHash: null, roles: [{ role: 'USER' }] },
    otherActiveAdmins: 0,
  });
  try {
    const result = await setUserStatus('user-1', false, 'admin-1');
    assert.equal(result.status, 'inactive');
  } finally { store.restore(); }
});
