import { invoke } from "@tauri-apps/api/core";

interface Configuration {
  id: string;
  name: string;
  url: string;
  useDefaultAuth: boolean;
}

interface TestResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: any;
}

interface SavedValueSet {
  id: string;
  name: string;
  queryParams: Record<string, string>;
  body: string;
  createdAt: string;
}

interface EndpointSavedSets {
  [configId: string]: {
    [method: string]: {
      [path: string]: SavedValueSet[];
    };
  };
}

interface SavedResult {
  id: string;
  name: string;
  endpoint: {
    method: string;
    path: string;
    configId: string;
  };
  request: {
    queryParams: Record<string, string>;
    body: string;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    data: any;
  };
  timestamp: string;
}

interface SavedResults {
  [configId: string]: SavedResult[];
}

class ConfigManager {
  private configs: Configuration[] = [];
  private editingId: string | null = null;
  private savedValueSets: EndpointSavedSets = {};
  private savedResults: SavedResults = {};
  private readonly STORAGE_KEY = 'openapiui-configurations';
  private readonly SAVED_SETS_KEY = 'openapiui-saved-sets';
  private readonly SAVED_RESULTS_KEY = 'openapiui-saved-results';
  private readonly THEME_KEY = 'openapiui-theme';

  private elements = {
    configForm: document.querySelector("#config-form") as HTMLFormElement,
    nameInput: document.querySelector("#config-name") as HTMLInputElement,
    urlInput: document.querySelector("#config-url") as HTMLInputElement,
    authCheckbox: document.querySelector("#config-auth") as HTMLInputElement,
    submitBtn: document.querySelector("#submit-btn") as HTMLButtonElement,
    cancelBtn: document.querySelector("#cancel-btn") as HTMLButtonElement,
    configsList: document.querySelector("#configs-list") as HTMLDivElement,
    configSelect: document.querySelector("#config-select") as HTMLSelectElement,
    editConfigsBtn: document.querySelector("#edit-configs-btn") as HTMLButtonElement,
    devtoolsBtn: document.querySelector("#devtools-btn") as HTMLButtonElement,
    themeToggleBtn: document.querySelector("#theme-toggle-btn") as HTMLButtonElement,
    configModal: document.querySelector("#config-modal") as HTMLDivElement,
    closeModalBtn: document.querySelector("#close-modal") as HTMLButtonElement,
    welcomeScreen: document.querySelector("#welcome-screen") as HTMLDivElement,
  };

  async init() {
    this.loadConfigs();
    this.loadSavedValueSets();
    this.loadSavedResults();
    this.loadTheme();
    this.setupEventListeners();
    this.updateConfigSelect();
    this.renderConfigs();
  }

  private setupEventListeners() {
    // Form de configuração
    this.elements.configForm.addEventListener("submit", (e) => {
      e.preventDefault();
      this.handleSubmit();
    });

    this.elements.cancelBtn.addEventListener("click", () => {
      this.resetForm();
    });

    // Modal
    this.elements.editConfigsBtn.addEventListener("click", () => {
      this.showModal();
    });

    this.elements.devtoolsBtn.addEventListener("click", async () => {
      try {
        await invoke('toggle_devtools');
      } catch (error) {
        console.error('Failed to toggle devtools:', error);
      }
    });

    this.elements.themeToggleBtn.addEventListener("click", () => {
      this.toggleTheme();
    });

    this.elements.closeModalBtn.addEventListener("click", () => {
      this.hideModal();
    });

    // Select de configurações
    this.elements.configSelect.addEventListener("change", (e) => {
      const selectedId = (e.target as HTMLSelectElement).value;
      this.handleConfigSelection(selectedId);
    });

    // Fechar modal clicando fora
    this.elements.configModal.addEventListener("click", (e) => {
      if (e.target === this.elements.configModal) {
        this.hideModal();
      }
    });
  }

  private loadConfigs() {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        this.configs = JSON.parse(stored);
      }
    } catch (error) {
      console.error('Failed to load configurations:', error);
      this.configs = [];
    }
  }

  private saveConfigs() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.configs, null, 2));
    } catch (error) {
      console.error('Failed to save configurations:', error);
    }
  }

  private loadSavedValueSets() {
    try {
      const stored = localStorage.getItem(this.SAVED_SETS_KEY);
      if (stored) {
        this.savedValueSets = JSON.parse(stored);
      }
    } catch (error) {
      console.error('Failed to load saved value sets:', error);
      this.savedValueSets = {};
    }
  }

  private saveSavedValueSets() {
    try {
      localStorage.setItem(this.SAVED_SETS_KEY, JSON.stringify(this.savedValueSets, null, 2));
    } catch (error) {
      console.error('Failed to save saved value sets:', error);
    }
  }

  private loadSavedResults() {
    try {
      const stored = localStorage.getItem(this.SAVED_RESULTS_KEY);
      if (stored) {
        this.savedResults = JSON.parse(stored);
      }
    } catch (error) {
      console.error('Failed to load saved results:', error);
      this.savedResults = {};
    }
  }

  private saveSavedResults() {
    try {
      localStorage.setItem(this.SAVED_RESULTS_KEY, JSON.stringify(this.savedResults, null, 2));
    } catch (error) {
      console.error('Failed to save saved results:', error);
    }
  }

  private updateConfigSelect() {
    this.elements.configSelect.innerHTML = '<option value="">Selecione uma configuração</option>';
    
    this.configs.forEach(config => {
      const option = document.createElement('option');
      option.value = config.id;
      option.textContent = config.name;
      this.elements.configSelect.appendChild(option);
    });
  }

  private async handleConfigSelection(configId: string) {
    if (!configId) {
      this.elements.welcomeScreen.style.display = 'block';
      this.elements.welcomeScreen.innerHTML = `
        <h2>Bem-vindo ao OpenAPI UI</h2>
        <p>Selecione uma configuração no menu superior ou clique em "Editar Configurações" para gerenciar suas APIs.</p>
      `;
      return;
    }

    const config = this.configs.find(c => c.id === configId);
    if (config) {
      this.elements.welcomeScreen.innerHTML = `
        <div class="selected-config">
          <div class="config-header">
            <div class="config-info">
              <h3>${this.escapeHtml(config.name)}</h3>
              <p><strong>URL:</strong> ${this.escapeHtml(config.url)}</p>
              <p><strong>Autenticação:</strong> ${config.useDefaultAuth ? 'Padrão' : 'Custom'}</p>
            </div>
            <button 
              class="global-history-btn" 
              data-config-id="${config.id}"
              title="Ver histórico de resultados"
            >
              📋 Histórico
            </button>
          </div>
          <div id="openapi-content" class="openapi-content">
            <p>Carregando especificação OpenAPI...</p>
          </div>
        </div>
      `;

      // Carregar o OpenAPI JSON
      await this.loadOpenApiSpec(config);
    }
  }

  private async loadOpenApiSpec(config: Configuration) {
    const openApiContent = document.getElementById('openapi-content') as HTMLDivElement;
    
    try {
      const fullUrl = `${config.url}/openapi.json`;
      console.log('Fetching OpenAPI spec from:', fullUrl);

      // Tentar usar o proxy Tauri primeiro (evita CORS)
      let openApiSpec: any;
      
      try {
        openApiSpec = await invoke('fetch_openapi_spec', {
          url: fullUrl,
          useAuth: config.useDefaultAuth
        });
        console.log('Successfully fetched via Tauri proxy');
      } catch (tauriError) {
        console.warn('Tauri proxy failed, falling back to fetch:', tauriError);
        
        // Fallback para fetch normal (com CORS)
        const headers: HeadersInit = {
          'Content-Type': 'application/json',
        };

        // Adicionar headers de autenticação se necessário
        if (config.useDefaultAuth) {
          try {
            const token = await this.getGcloudToken();
            if (token) {
              headers['Authorization'] = `Bearer ${token}`;
              headers['TokenPortal'] = token; // Header adicional conforme solicitado
            }
          } catch (error) {
            console.error('Failed to get gcloud token:', error);
            openApiContent.innerHTML = `
              <div class="error-message">
                <h4>Erro de Autenticação</h4>
                <p>Não foi possível obter o token do gcloud. Verifique se você está autenticado.</p>
                <details>
                  <summary>Detalhes do erro</summary>
                  <pre>${this.escapeHtml(String(error))}</pre>
                </details>
              </div>
            `;
            return;
          }
        }

        // Validar URL
        try {
          new URL(fullUrl);
        } catch (urlError) {
          throw new Error(`URL inválida: ${fullUrl}. Erro: ${String(urlError)}`);
        }

        console.log('Headers:', headers);

        const response = await fetch(fullUrl, {
          method: 'GET',
          headers: headers,
          mode: 'cors',
        });

        console.log('Response status:', response.status);
        console.log('Response headers:', response.headers);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        openApiSpec = await response.json();
      }

      this.displayOpenApiSpec(openApiSpec, openApiContent);

    } catch (error) {
      console.error('Failed to load OpenAPI spec:', error);
      this.displayError(error, openApiContent);
    }
  }

  private async getGcloudToken(): Promise<string> {
    try {
      const token = await invoke<string>('get_gcloud_token');
      return token;
    } catch (error) {
      throw new Error(`Failed to get gcloud token: ${String(error)}`);
    }
  }

  private displayOpenApiSpec(spec: any, container: HTMLDivElement) {
    const specHtml = `
      <div class="openapi-spec">
        <h4>Especificação OpenAPI</h4>
        <div class="spec-info">
          <p><strong>Título:</strong> ${this.escapeHtml(spec.info?.title || 'N/A')}</p>
          <p><strong>Versão:</strong> ${this.escapeHtml(spec.info?.version || 'N/A')}</p>
          <p><strong>Descrição:</strong> ${this.escapeHtml(spec.info?.description || 'N/A')}</p>
          <p><strong>Base URL:</strong> ${this.escapeHtml(spec.servers?.[0]?.url || 'N/A')}</p>
        </div>
        
        ${spec.paths ? `
          <div class="paths-section">
            <h5>Endpoints Disponíveis:</h5>
            <div class="paths-list">
              ${Object.entries(spec.paths)
                .filter(([, methods]: [string, any]) => {
                  // Filtrar endpoints que têm "summary": "Root"
                  return !Object.values(methods).some((method: any) => method.summary === 'Root');
                })
                .map(([path, methods]: [string, any]) => `
                <div class="path-item">
                  <div class="path-header" onclick="this.parentElement.classList.toggle('expanded')">
                    <h6>${this.escapeHtml(path)}</h6>
                    <span class="expand-icon">▶</span>
                  </div>
                  <div class="path-content">
                    <div class="methods">
                      ${Object.entries(methods).map(([method, details]: [string, any]) => `
                        <div class="method ${method.toLowerCase()}">
                          <div class="method-header">
                            <span class="method-type">${method.toUpperCase()}</span>
                            <span class="method-summary">${this.escapeHtml(details.summary || details.description || 'No description')}</span>
                          </div>
                          <div class="method-test">
                            ${this.generateTestInterface(method, details, path, spec)}
                          </div>
                        </div>
                      `).join('')}
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
        
        <details class="raw-json">
          <summary>Ver JSON Raw</summary>
          <pre><code>${this.escapeHtml(JSON.stringify(spec, null, 2))}</code></pre>
        </details>
      </div>
    `;
    
    container.innerHTML = specHtml;
    this.attachTestEventListeners();
    
    // Atualizar selects de conjuntos salvos para todos os endpoints
    const currentConfigId = this.getCurrentConfigId();
    if (currentConfigId && spec.paths) {
      Object.entries(spec.paths)
        .filter(([, methods]: [string, any]) => {
          // Filtrar endpoints que têm "summary": "Root"
          return !Object.values(methods).some((method: any) => method.summary === 'Root');
        })
        .forEach(([path, methods]: [string, any]) => {
          Object.keys(methods).forEach((method: string) => {
            this.updateSavedSetsSelect(method, path, currentConfigId);
          });
        });
    }
  }

  private displayError(error: unknown, container: HTMLDivElement) {
    const errorMessage = String(error);
    let statusText = '';
    let statusCode = '';
    let errorType = '';

    // Tentar extrair status code do erro
    if (errorMessage.includes('HTTP')) {
      const match = errorMessage.match(/HTTP (\d+): (.+)/);
      if (match) {
        statusCode = match[1];
        statusText = match[2];
        errorType = 'HTTP_ERROR';
      }
    } else if (errorMessage.includes('Failed to fetch')) {
      errorType = 'FETCH_ERROR';
    } else if (errorMessage.includes('CORS')) {
      errorType = 'CORS_ERROR';
    } else if (errorMessage.includes('NetworkError')) {
      errorType = 'NETWORK_ERROR';
    }

    const errorHtml = `
      <div class="error-message">
        <h4>Erro ao Carregar OpenAPI</h4>
        <div class="error-details">
          ${statusCode ? `<p><strong>Status:</strong> ${statusCode} ${statusText}</p>` : ''}
          <p><strong>Tipo:</strong> ${this.getErrorTypeDescription(errorType)}</p>
          <p><strong>Mensagem:</strong> ${this.escapeHtml(errorMessage)}</p>
        </div>
        
        ${errorType === 'FETCH_ERROR' || errorType === 'NETWORK_ERROR' ? `
          <div class="error-suggestion">
            <p><strong>Sugestão:</strong> Verifique se:</p>
            <ul>
              <li>A URL está correta e acessível</li>
              <li>O servidor está online</li>
              <li>Você tem conexão com a internet</li>
              <li>O endpoint /openapi.json existe</li>
            </ul>
          </div>
        ` : ''}
        
        ${errorType === 'CORS_ERROR' ? `
          <div class="error-suggestion">
            <p><strong>Sugestão:</strong> Erro de CORS detectado. Verifique se:</p>
            <ul>
              <li>O servidor permite requisições da origem ${window.location.origin}</li>
              <li>O servidor tem os headers CORS necessários</li>
              <li>Considere usar um proxy ou extensão para desenvolvimento</li>
            </ul>
          </div>
        ` : ''}
        
        ${statusCode === '403' ? `
          <div class="error-suggestion">
            <p><strong>Sugestão:</strong> Verifique se você tem permissão para acessar esta API.</p>
          </div>
        ` : ''}
        
        ${statusCode === '404' ? `
          <div class="error-suggestion">
            <p><strong>Sugestão:</strong> Verifique se a URL está correta e se o endpoint /openapi.json existe.</p>
          </div>
        ` : ''}
        
        ${statusCode === '401' ? `
          <div class="error-suggestion">
            <p><strong>Sugestão:</strong> Verifique se a autenticação está configurada corretamente.</p>
          </div>
        ` : ''}
        
        <details class="error-technical">
          <summary>Detalhes Técnicos</summary>
          <div class="debug-info">
            <p><strong>URL:</strong> <span id="error-url"></span></p>
            <p><strong>User Agent:</strong> ${navigator.userAgent}</p>
            <p><strong>Origem:</strong> ${window.location.origin}</p>
          </div>
          <pre>${this.escapeHtml(error instanceof Error ? error.stack || errorMessage : errorMessage)}</pre>
        </details>
      </div>
    `;
    
    container.innerHTML = errorHtml;
    
    // Preencher informações de debug se disponíveis
    setTimeout(() => {
      const urlElement = document.getElementById('error-url');
      if (urlElement) {
        urlElement.textContent = window.location.href;
      }
    }, 100);
  }

  private getErrorTypeDescription(errorType: string): string {
    switch (errorType) {
      case 'FETCH_ERROR':
        return 'Falha na requisição (possível problema de rede ou CORS)';
      case 'CORS_ERROR':
        return 'Erro de CORS (política de mesma origem)';
      case 'NETWORK_ERROR':
        return 'Erro de rede';
      case 'HTTP_ERROR':
        return 'Erro HTTP';
      default:
        return 'Erro desconhecido';
    }
  }

  private showModal() {
    this.elements.configModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  private hideModal() {
    this.elements.configModal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  private handleSubmit() {
    const name = this.elements.nameInput.value.trim();
    const url = this.elements.urlInput.value.trim();
    const useDefaultAuth = this.elements.authCheckbox.checked;

    if (!name || !url) {
      return;
    }

    if (this.editingId) {
      const configIndex = this.configs.findIndex(c => c.id === this.editingId);
      if (configIndex !== -1) {
        this.configs[configIndex] = {
          id: this.editingId,
          name,
          url,
          useDefaultAuth
        };
      }
    } else {
      const newConfig: Configuration = {
        id: Date.now().toString(),
        name,
        url,
        useDefaultAuth
      };
      this.configs.push(newConfig);
    }

    this.saveConfigs();
    this.updateConfigSelect();
    this.renderConfigs();
    this.resetForm();
  }

  private resetForm() {
    this.elements.configForm.reset();
    this.editingId = null;
    this.elements.submitBtn.textContent = 'Adicionar Configuração';
    this.elements.cancelBtn.classList.add('hidden');
  }

  private renderConfigs() {
    if (this.configs.length === 0) {
      this.elements.configsList.innerHTML = '<p class="empty-state">Nenhuma configuração adicionada ainda.</p>';
      return;
    }

    this.elements.configsList.innerHTML = this.configs.map(config => `
      <div class="config-item" data-id="${config.id}">
        <div class="config-details">
          <h4>${this.escapeHtml(config.name)}</h4>
          <p><strong>URL:</strong> ${this.escapeHtml(config.url)}</p>
          <p><strong>Autenticação:</strong> ${config.useDefaultAuth ? 'Padrão' : 'Custom'}</p>
        </div>
        <div class="config-actions">
          <button class="edit-btn" data-id="${config.id}">Editar</button>
          <button class="delete-btn" data-id="${config.id}">Excluir</button>
        </div>
      </div>
    `).join('');

    this.attachConfigEventListeners();
  }

  private attachConfigEventListeners() {
    document.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = (e.target as HTMLElement).dataset.id;
        if (id) this.editConfig(id);
      });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = (e.target as HTMLElement).dataset.id;
        if (id) this.deleteConfig(id);
      });
    });
  }

  private editConfig(id: string) {
    const config = this.configs.find(c => c.id === id);
    if (!config) return;

    this.editingId = id;
    this.elements.nameInput.value = config.name;
    this.elements.urlInput.value = config.url;
    this.elements.authCheckbox.checked = config.useDefaultAuth;
    this.elements.submitBtn.textContent = 'Atualizar Configuração';
    this.elements.cancelBtn.classList.remove('hidden');
    
    this.elements.nameInput.focus();
  }

  private deleteConfig(id: string) {
    this.configs = this.configs.filter(c => c.id !== id);
    this.saveConfigs();
    this.updateConfigSelect();
    this.renderConfigs();
  }

  private attachTestEventListeners() {
    document.querySelectorAll('.test-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;
        
        if (method && path && configId) {
          this.executeTest(method, path, configId);
        }
      });
    });

    // Adicionar event listeners para salvar conjuntos
    document.querySelectorAll('.save-set-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;
        
        if (method && path && configId) {
          this.saveValueSet(method, path, configId);
        }
      });
    });

    // Adicionar event listeners para carregar conjuntos
    document.querySelectorAll('.saved-sets-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const target = e.target as HTMLSelectElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;
        const selectedId = target.value;
        
        if (method && path && configId && selectedId) {
          this.loadValueSet(method, path, configId, selectedId);
        }
      });
    });

    // Adicionar event listeners para excluir conjuntos
    document.querySelectorAll('.delete-set-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;
        
        if (method && path && configId) {
          this.deleteValueSet(method, path, configId);
        }
      });
    });

    // Adicionar event listener para o botão global de histórico
    document.querySelectorAll('.global-history-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const configId = target.dataset.configId;
        
        if (configId) {
          this.showHistoryModal(configId);
        }
      });
    });
  }

  private saveValueSet(method: string, path: string, configId: string) {
    const pathId = path.replace(/[^a-zA-Z0-9]/g, '-');
    const nameInput = document.getElementById(`save-name-${method}-${pathId}`) as HTMLInputElement;
    const name = nameInput?.value?.trim();
    
    if (!name) {
      this.showToast('Por favor, digite um nome para este conjunto de valores.', 'error');
      return;
    }

    // Coletar query params atuais
    const queryParams: Record<string, string> = {};
    document.querySelectorAll(`[data-query-param="${method}-${pathId}"]`).forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      const value = (input as HTMLInputElement).value;
      if (param) {
        queryParams[param] = value;
      }
    });

    // Coletar body atual
    const bodyTextarea = document.getElementById(`body-${method}-${pathId}`) as HTMLTextAreaElement;
    const body = bodyTextarea?.value || '';

    // Inicializar estrutura se não existir
    if (!this.savedValueSets[configId]) {
      this.savedValueSets[configId] = {};
    }
    if (!this.savedValueSets[configId][method]) {
      this.savedValueSets[configId][method] = {};
    }
    if (!this.savedValueSets[configId][method][path]) {
      this.savedValueSets[configId][method][path] = [];
    }

    // Verificar se já existe um conjunto com o mesmo nome
    const existingIndex = this.savedValueSets[configId][method][path].findIndex(set => set.name === name);
    
    if (existingIndex !== -1) {
      // Substituir o conjunto existente
      this.savedValueSets[configId][method][path][existingIndex] = {
        ...this.savedValueSets[configId][method][path][existingIndex],
        queryParams,
        body,
        createdAt: new Date().toISOString()
      };
      this.showToast('Conjunto de valores atualizado com sucesso!', 'success');
    } else {
      // Criar novo conjunto
      const savedSet: SavedValueSet = {
        id: Date.now().toString(),
        name,
        queryParams,
        body,
        createdAt: new Date().toISOString()
      };

      // Adicionar o conjunto salvo
      this.savedValueSets[configId][method][path].push(savedSet);
      this.showToast('Conjunto de valores salvo com sucesso!', 'success');
    }
    
    // Salvar no localStorage
    this.saveSavedValueSets();
    
    // Manter o nome preenchido (não limpar o input)
    // nameInput.value = ''; // Removido para manter o nome
    
    // Atualizar o select
    this.updateSavedSetsSelect(method, path, configId);
  }

  private loadValueSet(method: string, path: string, configId: string, savedSetId: string) {
    const pathId = path.replace(/[^a-zA-Z0-9]/g, '-');
    const savedSet = this.savedValueSets[configId]?.[method]?.[path]?.find(set => set.id === savedSetId);
    
    if (!savedSet) {
      console.error('Conjunto salvo não encontrado:', savedSetId);
      return;
    }

    // Preencher query params
    Object.entries(savedSet.queryParams).forEach(([param, value]) => {
      const input = document.getElementById(`param-${param}-${pathId}`) as HTMLInputElement;
      if (input) {
        input.value = value;
      }
    });

    // Preencher body
    const bodyTextarea = document.getElementById(`body-${method}-${pathId}`) as HTMLTextAreaElement;
    if (bodyTextarea) {
      bodyTextarea.value = savedSet.body;
    }

    // Preencher o input do nome com o nome do conjunto
    const nameInput = document.getElementById(`save-name-${method}-${pathId}`) as HTMLInputElement;
    if (nameInput) {
      nameInput.value = savedSet.name;
    }
  }

  private updateSavedSetsSelect(method: string, path: string, configId: string) {
    const pathId = path.replace(/[^a-zA-Z0-9]/g, '-');
    const select = document.getElementById(`saved-sets-${method}-${pathId}`) as HTMLSelectElement;
    
    if (!select) return;

    const savedSets = this.savedValueSets[configId]?.[method]?.[path] || [];
    
    select.innerHTML = '<option value="">Selecione um conjunto salvo...</option>';
    
    savedSets.forEach(savedSet => {
      const option = document.createElement('option');
      option.value = savedSet.id;
      option.textContent = `${savedSet.name} (${new Date(savedSet.createdAt).toLocaleDateString()})`;
      select.appendChild(option);
    });
  }

  private deleteValueSet(method: string, path: string, configId: string) {
    const pathId = path.replace(/[^a-zA-Z0-9]/g, '-');
    const select = document.getElementById(`saved-sets-${method}-${pathId}`) as HTMLSelectElement;
    const selectedId = select?.value;
    
    if (!selectedId) {
      this.showToast('Por favor, selecione um conjunto para excluir.', 'error');
      return;
    }

    const savedSet = this.savedValueSets[configId]?.[method]?.[path]?.find(set => set.id === selectedId);
    
    if (!savedSet) {
      this.showToast('Conjunto não encontrado.', 'error');
      return;
    }

    // Diálogo de confirmação
    const confirmed = confirm(`Tem certeza que deseja excluir o conjunto "${savedSet.name}"? Esta ação não pode ser desfeita.`);
    
    if (!confirmed) {
      return;
    }

    // Remover o conjunto
    const sets = this.savedValueSets[configId][method][path];
    const index = sets.findIndex(set => set.id === selectedId);
    
    if (index !== -1) {
      sets.splice(index, 1);
      
      // Salvar no localStorage
      this.saveSavedValueSets();
      
      // Limpar o input do nome se estava preenchido com o nome do conjunto excluído
      const nameInput = document.getElementById(`save-name-${method}-${pathId}`) as HTMLInputElement;
      if (nameInput?.value === savedSet.name) {
        nameInput.value = '';
      }
      
      // Atualizar o select
      this.updateSavedSetsSelect(method, path, configId);
      
      this.showToast(`Conjunto "${savedSet.name}" excluído com sucesso!`, 'success');
    }
  }

  private attachResultEventListeners(method: string, path: string, configId: string, queryParams: Record<string, string>, body: string, response: TestResponse, timestamp: string) {
    // Event listener para salvar resultado
    const saveBtn = document.querySelector(`[data-method="${method}"][data-path="${path}"][data-config-id="${configId}"].save-result-btn`) as HTMLButtonElement;
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        this.saveTestResult(method, path, configId, queryParams, body, response, timestamp);
      });
    }

    // Event listener para exibir histórico
    const historyBtn = document.querySelector(`[data-method="${method}"][data-path="${path}"][data-config-id="${configId}"].show-history-btn`) as HTMLButtonElement;
    if (historyBtn) {
      historyBtn.addEventListener('click', () => {
        this.showHistoryModal(configId);
      });
    }
  }

  private saveTestResult(method: string, path: string, configId: string, queryParams: Record<string, string>, body: string, response: TestResponse, timestamp: string) {
    const pathId = path.replace(/[^a-zA-Z0-9]/g, '-');
    const nameInput = document.getElementById(`result-name-${method}-${pathId}`) as HTMLInputElement;
    const name = nameInput?.value?.trim();
    
    if (!name) {
      this.showToast('Por favor, digite um nome para este resultado.', 'error');
      return;
    }

    // Criar o resultado salvo
    const savedResult: SavedResult = {
      id: Date.now().toString(),
      name,
      endpoint: {
        method,
        path,
        configId
      },
      request: {
        queryParams,
        body
      },
      response: {
        status: response.status || 200,
        statusText: response.statusText || 'OK',
        headers: response.headers || {},
        data: response.data
      },
      timestamp
    };

    // Inicializar estrutura se não existir
    if (!this.savedResults[configId]) {
      this.savedResults[configId] = [];
    }

    // Adicionar o resultado salvo
    this.savedResults[configId].push(savedResult);
    
    // Salvar no localStorage
    this.saveSavedResults();
    
    this.showToast('Resultado salvo com sucesso!', 'success');
  }

  private showHistoryModal(configId: string) {
    // Criar modal de histórico
    const modal = document.createElement('div');
    modal.className = 'history-modal modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h2>Histórico de Resultados</h2>
          <button class="close-btn">&times;</button>
        </div>
        <div class="modal-body">
          <div class="history-controls">
            <label for="history-endpoint-select">Selecione o endpoint:</label>
            <select id="history-endpoint-select" class="history-endpoint-select">
              <option value="">Todos os endpoints</option>
            </select>
          </div>
          <div class="history-list">
            <div class="empty-state">Nenhum resultado salvo ainda.</div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';

    // Preencher select de endpoints
    this.populateHistoryEndpoints(configId);

    // Adicionar event listeners
    this.setupHistoryModalListeners(modal, configId);

    // Mostrar modal
    setTimeout(() => {
      modal.classList.remove('hidden');
    }, 10);
  }

  private populateHistoryEndpoints(configId: string) {
    const select = document.getElementById('history-endpoint-select') as HTMLSelectElement;
    if (!select) return;

    const results = this.savedResults[configId] || [];
    const endpoints = new Set<string>();

    results.forEach(result => {
      const endpointKey = `${result.endpoint.method} ${result.endpoint.path}`;
      endpoints.add(endpointKey);
    });

    endpoints.forEach(endpoint => {
      const option = document.createElement('option');
      option.value = endpoint;
      option.textContent = endpoint;
      select.appendChild(option);
    });
  }

  private setupHistoryModalListeners(modal: HTMLElement, configId: string) {
    // Fechar modal
    const closeBtn = modal.querySelector('.close-btn') as HTMLButtonElement;
    closeBtn.addEventListener('click', () => {
      this.closeHistoryModal(modal);
    });

    // Fechar clicando fora
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.closeHistoryModal(modal);
      }
    });

    // Mudança no select de endpoint
    const select = modal.querySelector('#history-endpoint-select') as HTMLSelectElement;
    select.addEventListener('change', () => {
      this.displayHistoryResults(configId, select.value);
      // Adicionar listeners para os novos botões de copiar
      this.attachCopyButtonsListeners();
      // Adicionar listeners para os novos botões de exclusão
      modal.querySelectorAll('.delete-result-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const target = e.target as HTMLElement;
          const resultId = target.dataset.resultId;
          const btnConfigId = target.dataset.configId;
          
          if (resultId && btnConfigId) {
            this.deleteSavedResult(resultId, btnConfigId);
          }
        });
      });
    });

    // Exibir todos os resultados inicialmente
    this.displayHistoryResults(configId, '');
    
    // Adicionar event listeners para os botões de copiar
    this.attachCopyButtonsListeners();
    
    // Adicionar event listeners para os botões de exclusão
    modal.querySelectorAll('.delete-result-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = e.target as HTMLElement;
        const resultId = target.dataset.resultId;
        const btnConfigId = target.dataset.configId;
        
        if (resultId && btnConfigId) {
          this.deleteSavedResult(resultId, btnConfigId);
        }
      });
    });
  }

  private closeHistoryModal(modal: HTMLElement) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    setTimeout(() => {
      document.body.removeChild(modal);
    }, 300);
  }

  private displayHistoryResults(configId: string, endpointFilter: string) {
    const listContainer = document.querySelector('.history-list') as HTMLElement;
    if (!listContainer) return;

    const results = this.savedResults[configId] || [];
    
    // Filtrar por endpoint se necessário
    const filteredResults = endpointFilter 
      ? results.filter(result => `${result.endpoint.method} ${result.endpoint.path}` === endpointFilter)
      : results;

    // Ordenar do mais recente para o mais antigo
    const sortedResults = filteredResults.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    if (sortedResults.length === 0) {
      listContainer.innerHTML = '<div class="empty-state">Nenhum resultado encontrado.</div>';
      return;
    }

    listContainer.innerHTML = sortedResults.map(result => `
      <div class="history-item collapsed" data-result-id="${result.id}">
        <div class="history-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <div class="history-title">
            <h4>${this.escapeHtml(result.name)}</h4>
            <div class="history-meta">
              <span class="history-endpoint">${result.endpoint.method} ${result.endpoint.path}</span>
              <span class="history-timestamp">${new Date(result.timestamp).toLocaleString('pt-BR')}</span>
            </div>
          </div>
          <div class="history-actions">
            <button 
              class="delete-result-btn" 
              data-result-id="${result.id}"
              data-config-id="${configId}"
              title="Excluir resultado"
              onclick="event.stopPropagation()"
            >
              🗑️
            </button>
            <span class="history-expand-icon">▶</span>
          </div>
        </div>
        <div class="history-content">
          <div class="history-content-inner">
            <div class="history-request">
              <h5>Request:</h5>
              ${Object.keys(result.request.queryParams).length > 0 ? `
                <div class="history-section">
                  <div class="section-header">
                    <p><strong>Query Params:</strong></p>
                    <button class="copy-btn" data-target="history-query-${result.id}">📋 Copiar</button>
                  </div>
                  <pre id="history-query-${result.id}">${this.escapeHtml(JSON.stringify(result.request.queryParams, null, 2))}</pre>
                </div>
              ` : ''}
              ${result.request.body ? `
                <div class="history-section">
                  <div class="section-header">
                    <p><strong>Body:</strong></p>
                    <button class="copy-btn" data-target="history-body-${result.id}">📋 Copiar</button>
                  </div>
                  <pre id="history-body-${result.id}">${this.escapeHtml(result.request.body)}</pre>
                </div>
              ` : ''}
            </div>
            <div class="history-response">
              <h5>Response (${result.response.status} ${result.response.statusText}):</h5>
              <div class="history-section">
                <div class="section-header">
                  <p><strong>Dados:</strong></p>
                  <button class="copy-btn" data-target="history-response-${result.id}">📋 Copiar</button>
                </div>
                <pre id="history-response-${result.id}">${this.escapeHtml(typeof result.response.data === 'string' ? result.response.data : JSON.stringify(result.response.data, null, 2))}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    `).join('');
  }

  private async executeTest(method: string, path: string, configId: string) {
    const config = this.configs.find(c => c.id === configId);
    if (!config) return;

    const testResult = document.getElementById(`test-result-${method}-${path.replace(/[^a-zA-Z0-9]/g, '-')}`);
    if (!testResult) return;

    // Coletar query params
    const queryParams: Record<string, string> = {};
    document.querySelectorAll(`[data-query-param="${method}-${path.replace(/[^a-zA-Z0-9]/g, '-')}"]`).forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      const value = (input as HTMLInputElement).value;
      if (param && value) {
        queryParams[param] = value;
      }
    });

    // Coletar body
    const bodyTextarea = document.getElementById(`body-${method}-${path.replace(/[^a-zA-Z0-9]/g, '-')}`) as HTMLTextAreaElement;
    const body = bodyTextarea?.value || '';

    console.log('Executando teste:', { method, path, configId, useAuth: config.useDefaultAuth });
    
    testResult.innerHTML = '<div class="test-loading">Executando teste...</div>';

    try {
      const baseUrl = config.url.replace(/\/$/, '');
      const queryString = Object.keys(queryParams).length > 0 
        ? '?' + Object.entries(queryParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
        : '';
      
      const fullUrl = `${baseUrl}${path}${queryString}`;
      console.log('URL completa:', fullUrl);

      // Usar o proxy Tauri para fazer a requisição com autenticação
      const response: TestResponse = await invoke('make_test_request', {
        url: fullUrl,
        method: method.toUpperCase(),
        body: body,
        useAuth: config.useDefaultAuth
      });

      console.log('Resposta recebida via Tauri proxy:', response);

      const pathId = path.replace(/[^a-zA-Z0-9]/g, '-');
      const timestamp = new Date().toISOString();
      const hasData = response.data && (typeof response.data === 'object' && Object.keys(response.data).length > 0 || typeof response.data === 'string' && response.data.trim());

      testResult.innerHTML = `
        <div class="test-result success">
          <div class="test-status">
            <div class="test-status-header">
              <h5>Resposta ${response.status || 200} ${response.statusText || 'OK'}</h5>
              ${hasData ? `
                <div class="test-result-actions">
                  <input 
                    type="text" 
                    id="result-name-${method}-${pathId}"
                    class="result-name-input"
                    placeholder="Nome do resultado..."
                    value="Resultado_${new Date().toLocaleString('pt-BR').replace(/[^\w]/g, '_')}"
                  />
                  <button 
                    class="save-result-btn" 
                    data-method="${method}"
                    data-path="${path}"
                    data-config-id="${configId}"
                    data-timestamp="${timestamp}"
                  >
                    Salvar Resultado
                  </button>
                  <button 
                    class="show-history-btn" 
                    data-method="${method}"
                    data-path="${path}"
                    data-config-id="${configId}"
                  >
                    Exibir Histórico
                  </button>
                </div>
              ` : ''}
            </div>
            <p><strong>URL:</strong> ${this.escapeHtml(fullUrl)}</p>
            ${response.headers ? `
              <div class="test-headers-section">
                <div class="section-header">
                  <p><strong>Headers enviados:</strong></p>
                  <button class="copy-btn" data-target="headers-${method}-${pathId}">📋 Copiar</button>
                </div>
                <pre id="headers-${method}-${pathId}" class="test-headers">${this.escapeHtml(JSON.stringify(response.headers, null, 2))}</pre>
              </div>
            ` : ''}
            ${body ? `
              <div class="test-body-section">
                <div class="section-header">
                  <p><strong>Body enviado:</strong></p>
                  <button class="copy-btn" data-target="body-${method}-${pathId}">📋 Copiar</button>
                </div>
                <pre id="body-${method}-${pathId}" class="test-body">${this.escapeHtml(body)}</pre>
              </div>
            ` : ''}
          </div>
          <div class="test-response">
            <div class="section-header">
              <h6>Resposta:</h6>
              <button class="copy-btn" data-target="response-${method}-${pathId}">📋 Copiar</button>
            </div>
            <pre id="response-${method}-${pathId}" class="test-response-data">${this.escapeHtml(typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2))}</pre>
          </div>
        </div>
      `;

      // Adicionar event listeners para os novos botões
      if (hasData) {
        this.attachResultEventListeners(method, path, configId, queryParams, body, response, timestamp);
      }

      // Adicionar event listeners para os botões de copiar
      this.attachCopyButtonsListeners();

    } catch (error) {
      console.error('Erro na requisição:', error);
      testResult.innerHTML = `
        <div class="test-error">
          <h5>Erro na requisição</h5>
          <pre>${this.escapeHtml(String(error))}</pre>
        </div>
      `;
    }
  }

  private generateTestInterface(method: string, details: any, path: string, spec: any): string {
    const queryParams = details.parameters?.filter((param: any) => param.in === 'query') || [];
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());
    const exampleBody = this.generateExampleBody(details, spec);
    const pathId = path.replace(/[^a-zA-Z0-9]/g, '-');
    const currentConfig = this.configs.find(c => c.id === this.getCurrentConfigId());

    return `
      <div class="test-interface">
        ${queryParams.length > 0 ? `
          <div class="query-params">
            <h6>Query Parameters:</h6>
            ${queryParams.map((param: any) => `
              <div class="param-input">
                <label for="param-${param.name}-${pathId}">
                  ${this.escapeHtml(param.name)} ${param.required ? '<span class="required">*</span>' : ''}
                </label>
                <input 
                  type="text" 
                  id="param-${param.name}-${pathId}"
                  data-query-param="${method}-${pathId}"
                  data-param="${param.name}"
                  placeholder="${this.escapeHtml(param.description || `Digite ${param.name}...`)}"
                  value="${this.escapeHtml(param.schema?.default?.toString() || '')}"
                  ${param.required ? 'required' : ''}
                />
              </div>
            `).join('')}
          </div>
        ` : ''}
        
        ${hasBody ? `
          <div class="body-input">
            <h6>Body (JSON):</h6>
            <textarea 
              id="body-${method}-${pathId}"
              class="body-textarea"
              placeholder="Digite o JSON do corpo da requisição..."
              rows="6"
            >${this.escapeHtml(exampleBody)}</textarea>
          </div>
        ` : ''}
        
        <div class="test-actions">
          <button 
            class="test-btn" 
            data-method="${method}"
            data-path="${path}"
            data-config-id="${currentConfig?.id || ''}"
          >
            Testar ${method.toUpperCase()}
          </button>
        </div>
        
        <div class="saved-sets-section">
          <h6>Conjuntos de Valores Salvos:</h6>
          <div class="save-set-controls">
            <input 
              type="text" 
              id="save-name-${method}-${pathId}"
              class="save-name-input"
              placeholder="Nome para este conjunto..."
            />
            <button 
              class="save-set-btn" 
              data-method="${method}"
              data-path="${path}"
              data-config-id="${currentConfig?.id || ''}"
            >
              Salvar Valores Atuais
            </button>
          </div>
          <div class="load-set-controls">
            <label for="saved-sets-${method}-${pathId}">Carregar conjunto:</label>
            <div class="load-set-row">
              <select 
                id="saved-sets-${method}-${pathId}"
                class="saved-sets-select"
                data-method="${method}"
                data-path="${path}"
                data-config-id="${currentConfig?.id || ''}"
              >
                <option value="">Selecione um conjunto salvo...</option>
              </select>
              <button 
                class="delete-set-btn" 
                data-method="${method}"
                data-path="${path}"
                data-config-id="${currentConfig?.id || ''}"
                title="Excluir conjunto selecionado"
              >
                🗑️
              </button>
            </div>
          </div>
        </div>
        
        <div id="test-result-${method}-${pathId}" class="test-result-container"></div>
      </div>
    `;
  }

  private generateExampleBody(details: any, spec: any): string {
    // Tentar obter exemplo do requestBody
    if (details.requestBody?.content?.['application/json']?.example) {
      return JSON.stringify(details.requestBody.content['application/json'].example, null, 2);
    }
    
    // Tentar obter exemplo do schema
    if (details.requestBody?.content?.['application/json']?.schema) {
      return this.generateExampleFromSchema(details.requestBody.content['application/json'].schema, spec);
    }
    
    // Gerar exemplo baseado no método
    const method = details.method?.toLowerCase() || 'post';
    if (method === 'post' || method === 'put') {
      return '{\n  "key": "value"\n}';
    }
    
    return '';
  }

  private generateExampleFromSchema(schema: any, spec: any): string {
    if (schema.example) {
      return JSON.stringify(schema.example, null, 2);
    }
    
    if (schema.$ref) {
      const refPath = schema.$ref.replace('#/', '').split('/');
      let resolved: any = spec;
      for (const part of refPath) {
        resolved = resolved?.[part];
      }
      if (resolved) {
        return this.generateExampleFromSchema(resolved, spec);
      }
    }
    
    if (schema.type === 'object' && schema.properties) {
      const obj: any = {};
      Object.entries(schema.properties).forEach(([key, prop]: [string, any]) => {
        if (prop.example) {
          obj[key] = prop.example;
        } else if (prop.type === 'string') {
          obj[key] = prop.enum?.[0] || `string_${key}`;
        } else if (prop.type === 'number' || prop.type === 'integer') {
          obj[key] = prop.minimum || 0;
        } else if (prop.type === 'boolean') {
          obj[key] = true;
        } else if (prop.type === 'array') {
          obj[key] = [];
        } else {
          obj[key] = null;
        }
      });
      return JSON.stringify(obj, null, 2);
    }
    
    return '{}';
  }

  private getCurrentConfigId(): string {
    return this.elements.configSelect.value || '';
  }

  private showToast(message: string, type: 'success' | 'error' = 'success') {
    // Criar elemento do toast
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    // Adicionar ao DOM
    document.body.appendChild(toast);
    
    // Remover após 10 segundos
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 10000);
  }

  private attachCopyButtonsListeners() {
    // Event listeners para botões de copiar
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const targetId = target.dataset.target;
        
        if (targetId) {
          const element = document.getElementById(targetId);
          if (element) {
            const text = element.textContent || '';
            navigator.clipboard.writeText(text).then(() => {
              this.showToast('Conteúdo copiado para a área de transferência!', 'success');
            }).catch(() => {
              this.showToast('Falha ao copiar conteúdo', 'error');
            });
          }
        }
      });
    });
  }

  private deleteSavedResult(resultId: string, configId: string) {
    if (!confirm('Tem certeza que deseja excluir este resultado salvo?')) {
      return;
    }

    const results = this.savedResults[configId] || [];
    const updatedResults = results.filter(result => result.id !== resultId);
    
    if (updatedResults.length === 0) {
      delete this.savedResults[configId];
    } else {
      this.savedResults[configId] = updatedResults;
    }
    
    this.saveSavedResults();
    
    // Atualizar a exibição
    const select = document.querySelector('#history-endpoint-select') as HTMLSelectElement;
    this.displayHistoryResults(configId, select?.value || '');
    
    this.showToast('Resultado excluído com sucesso!', 'success');
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private loadTheme() {
    try {
      const savedTheme = localStorage.getItem(this.THEME_KEY);
      if (savedTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        this.elements.themeToggleBtn.textContent = '🌙';
      } else {
        document.documentElement.removeAttribute('data-theme');
        this.elements.themeToggleBtn.textContent = '☀️';
      }
    } catch (error) {
      console.error('Failed to load theme:', error);
    }
  }

  private toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const isDark = currentTheme === 'dark';
    
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      this.elements.themeToggleBtn.textContent = '☀️';
      localStorage.setItem(this.THEME_KEY, 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      this.elements.themeToggleBtn.textContent = '🌙';
      localStorage.setItem(this.THEME_KEY, 'dark');
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const configManager = new ConfigManager();
  configManager.init();
});
