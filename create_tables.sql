-- =====================================================
-- OpenAPI UI - PostgreSQL Schema
-- =====================================================

-- Tabela para armazenar conjuntos de valores salvos
CREATE TABLE IF NOT EXISTS value_sets (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    config_id VARCHAR(255) NOT NULL,
    endpoint_method VARCHAR(10) NOT NULL,
    endpoint_path VARCHAR(500) NOT NULL,
    path_params JSONB,
    query_params JSONB,
    body TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    user_account VARCHAR(255)
);

-- Tabela para armazenar resultados de testes
CREATE TABLE IF NOT EXISTS test_results (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    config_id VARCHAR(255) NOT NULL,
    endpoint_method VARCHAR(10) NOT NULL,
    endpoint_path VARCHAR(500) NOT NULL,
    request_data JSONB,
    response_data JSONB,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    user_account VARCHAR(255)
);

-- Índices para performance das consultas
CREATE INDEX IF NOT EXISTS idx_value_sets_config_endpoint ON value_sets (config_id, endpoint_method, endpoint_path);
CREATE INDEX IF NOT EXISTS idx_test_results_config_endpoint ON test_results (config_id, endpoint_method, endpoint_path);

-- Índices únicos para evitar duplicatas de nomes dentro do mesmo endpoint
-- Isso permite que o sistema substitua um registro existente com o mesmo nome
-- em vez de criar duplicatas (upsert baseado no nome)
CREATE UNIQUE INDEX IF NOT EXISTS idx_value_sets_unique_name ON value_sets (name, config_id, endpoint_method, endpoint_path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_test_results_unique_name ON test_results (name, config_id, endpoint_method, endpoint_path);

-- Comentários sobre os índices únicos
COMMENT ON INDEX idx_value_sets_unique_name IS 'Garante nomes únicos para value sets dentro do mesmo endpoint';
COMMENT ON INDEX idx_test_results_unique_name IS 'Garante nomes únicos para test results dentro do mesmo endpoint';

-- Índices adicionais para buscas comuns
CREATE INDEX IF NOT EXISTS idx_value_sets_created_at ON value_sets (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_results_timestamp ON test_results (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_value_sets_user_account ON value_sets (user_account);
CREATE INDEX IF NOT EXISTS idx_test_results_user_account ON test_results (user_account);

-- Comentários para documentação
COMMENT ON TABLE value_sets IS 'Conjuntos de valores salvos para endpoints da API';
COMMENT ON TABLE test_results IS 'Resultados de testes executados nos endpoints da API';

COMMENT ON COLUMN value_sets.id IS 'Identificador único do conjunto de valores';
COMMENT ON COLUMN value_sets.name IS 'Nome descritivo do conjunto';
COMMENT ON COLUMN value_sets.config_id IS 'ID da configuração da API';
COMMENT ON COLUMN value_sets.endpoint_method IS 'Método HTTP (GET, POST, etc)';
COMMENT ON COLUMN value_sets.endpoint_path IS 'Caminho do endpoint';
COMMENT ON COLUMN value_sets.path_params IS 'Parâmetros de caminho em formato JSON';
COMMENT ON COLUMN value_sets.query_params IS 'Parâmetros de query em formato JSON';
COMMENT ON COLUMN value_sets.body IS 'Corpo da requisição';
COMMENT ON COLUMN value_sets.created_at IS 'Data de criação do conjunto';
COMMENT ON COLUMN value_sets.user_account IS 'Conta do usuário que criou';

COMMENT ON COLUMN test_results.id IS 'Identificador único do resultado';
COMMENT ON COLUMN test_results.name IS 'Nome descritivo do resultado';
COMMENT ON COLUMN test_results.config_id IS 'ID da configuração da API';
COMMENT ON COLUMN test_results.endpoint_method IS 'Método HTTP (GET, POST, etc)';
COMMENT ON COLUMN test_results.endpoint_path IS 'Caminho do endpoint';
COMMENT ON COLUMN test_results.request_data IS 'Dados completos da requisição em JSON';
COMMENT ON COLUMN test_results.response_data IS 'Dados completos da resposta em JSON';
COMMENT ON COLUMN test_results.timestamp IS 'Data/hora da execução do teste';
COMMENT ON COLUMN test_results.user_account IS 'Conta do usuário que executou';
