/** Build signup legalAcceptances for integration tests. */
export async function buildSignupAcceptances(service, role = 'investor') {
  if (service?.ensureLegalDraftsSeeded) {
    await service.ensureLegalDraftsSeeded();
  }
  const packet = await service.getSignupLegalPacket(role);
  return packet.documents.map((d) => ({
    documentType: d.documentType,
    documentVersionId: d.id,
    versionNumber: d.versionNumber,
    viewedAt: new Date().toISOString(),
    viewed: true,
  }));
}

export async function attachLegalToAuth(auth, pool) {
  const { PostgresGrowBangladeshService } = await import('../../src/postgres_service.js');
  const service = new PostgresGrowBangladeshService(pool);
  auth.growService = service;
  await service.ensureLegalDraftsSeeded();
  return service;
}
