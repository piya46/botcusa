export function vertexSettings(env: Record<string, string | undefined>) {
  const project = env.GOOGLE_CLOUD_PROJECT?.trim() || '';
  const location = env.GOOGLE_CLOUD_LOCATION?.trim() || 'global';
  const embeddingLocation = env.VERTEX_AI_EMBEDDING_LOCATION?.trim() || 'us-central1';
  const model = env.VERTEX_AI_MODEL?.trim() || '';
  const embeddingModel = env.VERTEX_AI_EMBEDDING_MODEL?.trim() || '';
  if (project && !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project))
    throw new Error('GOOGLE_CLOUD_PROJECT ต้องเป็น Project ID ไม่ใช่ชื่อแสดงผล');
  for (const value of [location, embeddingLocation])
    if (!/^(global|[a-z]+-[a-z]+\d+)$/.test(value))
      throw new Error('ระบุ location เช่น global หรือ us-central1');
  for (const value of [model, embeddingModel])
    if (value && !/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,119}$/.test(value))
      throw new Error('ระบุ Model ID ไม่ใส่ models/ หรือ URL นำหน้า');
  if (
    embeddingModel &&
    !['gemini-embedding-001', 'text-embedding-005', 'text-multilingual-embedding-002'].includes(
      embeddingModel,
    )
  )
    throw new Error(
      'Embedding รองรับ gemini-embedding-001, text-embedding-005 หรือ text-multilingual-embedding-002 ผ่าน Vertex predict',
    );
  return {
    vertexProject: project,
    vertexLocation: location,
    vertexEmbeddingLocation: embeddingLocation,
    vertexModel: model,
    embeddingModel,
    vertexCredentials: env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || '',
  };
}
