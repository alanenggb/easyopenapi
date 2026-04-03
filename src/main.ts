import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Configuration {
  id: string;
  name: string;
  url: string;
  useDefaultAuth: boolean;
  headers: Array<{ name: string; value: string }>;
  gcpSecretName?: string;
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
  pathParams: Record<string, string>;
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
    pathParams: Record<string, string>;
    queryParams: Record<string, string>;
    body: string;
    sentUuid?: string; // UUID enviado no header da requisição
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    data: any;
  };
  timestamp: string;
  storageLocation?: 'local' | 'database';
  userAccount?: string;
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
  private readonly FONT_SIZE_KEY = 'openapiui-font-size';
  private defaultBodyValues = new Map<string, string>();
  private readonly APP_VERSION = '0.1.0'; // Versão atual do aplicativo
  private cachedGcloudUser: string | null = null; // Cache para usuário gcloud

  private elements = {
    configForm: document.querySelector("#config-form") as HTMLFormElement,
    nameInput: document.querySelector("#config-name") as HTMLInputElement,
    urlInput: document.querySelector("#config-url") as HTMLInputElement,
    bucketInput: document.querySelector("#config-bucket") as HTMLInputElement,
    authCheckbox: document.querySelector("#config-auth") as HTMLInputElement,
    headersList: document.querySelector("#headers-list") as HTMLDivElement,
    addHeaderBtn: document.querySelector("#add-header-btn") as HTMLButtonElement,
    submitBtn: document.querySelector("#submit-btn") as HTMLButtonElement,
    cancelBtn: document.querySelector("#cancel-btn") as HTMLButtonElement,
    configsList: document.querySelector("#configs-list") as HTMLDivElement,
    configSelect: document.querySelector("#config-select") as HTMLSelectElement,
    fontSizeSelect: document.querySelector("#font-size-select") as HTMLSelectElement,
    reloadSpecBtn: document.querySelector("#reload-spec-btn") as HTMLButtonElement,
    editConfigsBtn: document.querySelector("#edit-configs-btn") as HTMLButtonElement,
    devtoolsBtn: document.querySelector("#devtools-btn") as HTMLButtonElement,
    themeToggleBtn: document.querySelector("#theme-toggle-btn") as HTMLButtonElement,
    aboutBtn: document.querySelector("#about-btn") as HTMLButtonElement,
    extrasMenu: document.querySelector(".extras-menu") as HTMLDivElement,
    extrasMenuBtn: document.querySelector("#extras-menu-btn") as HTMLButtonElement,
    extrasDropdown: document.querySelector("#extras-dropdown") as HTMLDivElement,
    configModal: document.querySelector("#config-modal") as HTMLDivElement,
    closeModalBtn: document.querySelector("#close-modal") as HTMLButtonElement,
    aboutModal: document.querySelector("#about-modal") as HTMLDivElement,
    closeAboutModalBtn: document.querySelector("#close-about-modal") as HTMLButtonElement,
    welcomeScreen: document.querySelector("#welcome-screen") as HTMLDivElement,
  };

  async init() {
    await Promise.all([
      this.loadConfigs(),
      this.loadSavedValueSets(),
      this.loadSavedResults(),
      this.loadTheme(),
      this.loadFontSize(),
      this.loadGcloudUser() // Carregar usuário gcloud no cache
    ]);
    this.setupEventListeners();
    this.updateConfigSelect();
    this.renderConfigs();
    
    // Atualizar título da janela ao iniciar
    await this.updateWindowTitle();
  }

  private setupEventListeners() {
    // Form de configuração
    this.elements.configForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      await this.handleSubmit();
    });

    this.elements.cancelBtn.addEventListener("click", () => {
      this.resetForm();
    });

    // Botão de adicionar header
    this.elements.addHeaderBtn.addEventListener("click", () => {
      this.addHeaderField();
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

    // Menu de Opções Extras
    this.elements.extrasMenuBtn.addEventListener("click", () => {
      this.toggleExtrasDropdown();
    });

    this.elements.fontSizeSelect.addEventListener("change", (e) => {
      const target = e.target as HTMLSelectElement;
      const fontSize = parseFloat(target.value);
      this.setFontSize(fontSize);
    });

    // Modal Sobre
    this.elements.aboutBtn.addEventListener("click", () => {
      this.showAboutModal();
    });

    this.elements.closeAboutModalBtn.addEventListener("click", () => {
      this.hideAboutModal();
    });

    this.elements.closeModalBtn.addEventListener("click", () => {
      this.hideModal();
    });

    // Select de configurações
    this.elements.configSelect.addEventListener("change", (e) => {
      const selectedId = (e.target as HTMLSelectElement).value;
      this.handleConfigSelection(selectedId);
    });

    // Botão de recarregar especificação
    this.elements.reloadSpecBtn.addEventListener("click", () => {
      const selectedId = this.elements.configSelect.value;
      if (selectedId) {
        this.handleConfigSelection(selectedId);
      }
    });

    // Event delegation para botões de reset
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('reset-btn')) {
        const resetType = target.dataset.reset;
        if (resetType) {
          this.handleReset(resetType);
        }
      }
    });

    // Fechar modal clicando fora
    this.elements.configModal.addEventListener("click", (e) => {
      if (e.target === this.elements.configModal) {
        this.hideModal();
      }
    });

    // Fechar modal Sobre clicando fora
    this.elements.aboutModal.addEventListener("click", (e) => {
      if (e.target === this.elements.aboutModal) {
        this.hideAboutModal();
      }
    });

    // Fechar modais com a tecla ESC
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.handleEscapeKey();
      }
    });

    // Fechar dropdown clicando fora
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (!this.elements.extrasMenu.contains(target)) {
        this.elements.extrasDropdown.classList.add('hidden');
      }
    });
  }

  private async loadGcloudUser() {
    try {
      this.cachedGcloudUser = await invoke<string>('get_gcloud_account');
    } catch (error) {
      console.warn('Could not load gcloud user on startup:', error);
      this.cachedGcloudUser = null;
    }
  }

  private async loadConfigs() {
    try {
      // Tentar carregar do app_data_dir primeiro
      try {
        const stored = await invoke<any>('load_app_data', { key: this.STORAGE_KEY });
        if (stored) {
          this.configs = stored;
        } else {
          this.configs = [];
        }
      } catch (appDataError) {
        console.warn('Failed to load from app_data_dir, falling back to localStorage:', appDataError);
        
        // Fallback para localStorage
        const stored = localStorage.getItem(this.STORAGE_KEY);
        if (stored) {
          this.configs = JSON.parse(stored);
          // Migrar para app_data_dir
          await this.saveConfigs();
        } else {
          this.configs = [];
        }
      }
    } catch (error) {
      console.error('Failed to load configurations:', error);
      this.configs = [];
    }
  }

  private async saveConfigs() {
    try {
      await invoke('save_app_data', { 
        key: this.STORAGE_KEY, 
        value: this.configs 
      });
    } catch (error) {
      console.error('Failed to save configurations to app_data_dir:', error);
      
      // Fallback para localStorage
      try {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.configs, null, 2));
      } catch (localStorageError) {
        console.error('Failed to save to localStorage fallback:', localStorageError);
      }
    }
  }

  private async loadSavedValueSets() {
    try {
      // Tentar carregar do app_data_dir primeiro
      try {
        const stored = await invoke<any>('load_app_data', { key: this.SAVED_SETS_KEY });
        if (stored) {
          this.savedValueSets = stored;
        } else {
          this.savedValueSets = {};
        }
      } catch (appDataError) {
        console.warn('Failed to load from app_data_dir, falling back to localStorage:', appDataError);
        
        // Fallback para localStorage
        const stored = localStorage.getItem(this.SAVED_SETS_KEY);
        if (stored) {
          this.savedValueSets = JSON.parse(stored);
          // Migrar para app_data_dir
          await this.saveSavedValueSets();
        } else {
          this.savedValueSets = {};
        }
      }
    } catch (error) {
      console.error('Failed to load saved value sets:', error);
      this.savedValueSets = {};
    }
  }

  private async saveSavedValueSets() {
    try {
      await invoke('save_app_data', { 
        key: this.SAVED_SETS_KEY, 
        value: this.savedValueSets 
      });
    } catch (error) {
      console.error('Failed to save saved value sets to app_data_dir:', error);
      
      // Fallback para localStorage
      try {
        localStorage.setItem(this.SAVED_SETS_KEY, JSON.stringify(this.savedValueSets, null, 2));
      } catch (localStorageError) {
        console.error('Failed to save to localStorage fallback:', localStorageError);
      }
    }
  }

  private async loadSavedResults() {
    try {
      // Tentar carregar do app_data_dir primeiro
      try {
        const stored = await invoke<any>('load_app_data', { key: this.SAVED_RESULTS_KEY });
        if (stored) {
          this.savedResults = stored;
        } else {
          this.savedResults = {};
        }
      } catch (appDataError) {
        console.warn('Failed to load from app_data_dir, falling back to localStorage:', appDataError);
        
        // Fallback para localStorage
        const stored = localStorage.getItem(this.SAVED_RESULTS_KEY);
        if (stored) {
          this.savedResults = JSON.parse(stored);
          // Migrar para app_data_dir
          await this.saveSavedResults();
        } else {
          this.savedResults = {};
        }
      }
    } catch (error) {
      console.error('Failed to load saved results:', error);
      this.savedResults = {};
    }
  }

  private async saveSavedResults() {
    try {
      await invoke('save_app_data', { 
        key: this.SAVED_RESULTS_KEY, 
        value: this.savedResults 
      });
    } catch (error) {
      console.error('Failed to save saved results to app_data_dir:', error);
      
      // Fallback para localStorage
      try {
        localStorage.setItem(this.SAVED_RESULTS_KEY, JSON.stringify(this.savedResults, null, 2));
      } catch (localStorageError) {
        console.error('Failed to save to localStorage fallback:', localStorageError);
      }
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
    // Atualizar título da janela
    await this.updateWindowTitle();
    
    if (!configId) {
      this.elements.welcomeScreen.style.display = 'block';
      this.elements.welcomeScreen.innerHTML = `
        <h2>Bem-vindo ao OpenAPI UI</h2>
        <p>Selecione uma configuração no menu superior ou clique em "Editar Configurações" para gerenciar suas APIs.</p>
      `;
      this.elements.reloadSpecBtn.disabled = true;
      return;
    }

    this.elements.reloadSpecBtn.disabled = false;

    const config = this.configs.find(c => c.id === configId);
    if (config) {
      this.elements.welcomeScreen.innerHTML = `
        <div class="selected-config">
          <div class="config-header">
            <div class="config-info">
              <h3>${this.escapeHtml(config.name)}</h3>
              <p><strong>URL:</strong> ${this.escapeHtml(config.url)}</p>
              <p><strong>Autenticação:</strong> ${config.useDefaultAuth ? 'gcloud' : 'não'}</p>
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
    // Obter o ID da configuração atual antes de usá-lo
    const currentConfigId = this.getCurrentConfigId();
    
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
                .map(([path, methods]: [string, any]) => {
                  // Filtrar apenas os métodos que não têm "summary": "Root"
                  const filteredMethods = Object.entries(methods).filter(([, details]: [string, any]) => details.summary !== 'Root');
                  
                  // Criar itens individuais para cada método
                  return filteredMethods.map(([method, details]: [string, any]) => `
                    <div class="path-item method-item">
                      <div class="path-header" onclick="this.parentElement.classList.toggle('expanded')">
                        <div class="endpoint-info">
                          <span class="method-type ${method.toLowerCase()}">${method.toUpperCase()}</span>
                          <h6>${this.escapeHtml(path)}</h6>
                          <span class="method-summary">${this.escapeHtml(details.summary || details.description || 'No description')}</span>
                        </div>
                        <span class="expand-icon">▶</span>
                      </div>
                      <div class="path-content">
                        <div class="method-test">
                          ${this.generateTestInterface(method, details, path, spec, currentConfigId)}
                        </div>
                      </div>
                    </div>
                  `).join('');
                }).join('')}
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
    if (currentConfigId && spec.paths) {
      Object.entries(spec.paths).forEach(([path, methods]: [string, any]) => {
        // Filtrar apenas os métodos que não têm "summary": "Root"
        const filteredMethods = Object.entries(methods).filter(([, details]: [string, any]) => details.summary !== 'Root');
        
        filteredMethods.forEach(([method]: [string, any]) => {
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

  private showAboutModal() {
    this.elements.aboutModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    this.loadAppVersion();
  }

  private async loadAppVersion() {
    try {
      // Tentar carregar do package.json via Tauri (se disponível)
      const packageJson = await invoke<string>('read_package_json');
      const packageData = JSON.parse(packageJson);
      const versionElement = document.getElementById('app-version');
      if (versionElement) {
        versionElement.textContent = packageData.version || this.APP_VERSION;
      }
    } catch (error) {
      console.error('Failed to load app version from package.json, using fallback:', error);
      // Usar versão embutida como fallback
      const versionElement = document.getElementById('app-version');
      if (versionElement) {
        versionElement.textContent = this.APP_VERSION;
      }
    }
  }

  private hideAboutModal() {
    this.elements.aboutModal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  private toggleExtrasDropdown() {
    this.elements.extrasDropdown.classList.toggle('hidden');
  }

  private handleEscapeKey() {
    // Verificar se algum modal está aberto e fechá-lo
    if (!this.elements.configModal.classList.contains('hidden')) {
      this.hideModal();
    }
    
    if (!this.elements.aboutModal.classList.contains('hidden')) {
      this.hideAboutModal();
    }
    
    // Verificar se modal de histórico está aberto
    const historyModal = document.querySelector('.history-modal:not(.hidden)') as HTMLElement;
    if (historyModal) {
      this.closeHistoryModal(historyModal);
    }
    
    // Fechar dropdown de opções extras
    if (!this.elements.extrasDropdown.classList.contains('hidden')) {
      this.elements.extrasDropdown.classList.add('hidden');
    }
  }

  private async handleSubmit() {
    const name = this.elements.nameInput.value.trim();
    const url = this.elements.urlInput.value.trim();
    const gcpSecretName = this.elements.bucketInput.value.trim() || undefined;
    const useDefaultAuth = this.elements.authCheckbox.checked;
    const headers = this.getHeadersFromForm();

    if (!name || !url) {
      return;
    }

    // Verificar se já existe configuração com a mesma URL (apenas para novas configurações)
    if (!this.editingId) {
      const normalizedUrlId = this.normalizeUrlToId(url);
      const existingConfig = this.configs.find(c => c.id === normalizedUrlId);
      if (existingConfig) {
        this.showToast(`Já existe uma configuração para esta URL: ${existingConfig.name}`, 'error');
        return;
      }
    }

    if (this.editingId) {
      const configIndex = this.configs.findIndex(c => c.id === this.editingId);
      if (configIndex !== -1) {
        this.configs[configIndex] = {
          id: this.editingId,
          name,
          url,
          gcpSecretName,
          useDefaultAuth,
          headers
        };
      }
    } else {
      const newConfig: Configuration = {
        id: this.normalizeUrlToId(url),
        name,
        url,
        gcpSecretName,
        useDefaultAuth,
        headers
      };
      this.configs.push(newConfig);
    }

    await this.saveConfigs();
    this.updateConfigSelect();
    this.renderConfigs();
    this.resetForm();
  }

  private resetForm() {
    this.elements.configForm.reset();
    this.clearHeaderFields();
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
          ${config.gcpSecretName ? `<p><strong>Bucket GCS:</strong> ${this.escapeHtml(config.gcpSecretName)}</p>` : ''}
          ${config.headers && config.headers.length > 0 ? `
            <p><strong>Headers:</strong></p>
            <div class="config-headers">
              ${config.headers.map(header => 
                `<span class="config-header">${this.escapeHtml(header.name)}: ${this.escapeHtml(header.value)}</span>`
              ).join('')}
            </div>
          ` : ''}
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
      btn.addEventListener('click', async (e) => {
        const id = (e.target as HTMLElement).dataset.id;
        if (id) await this.deleteConfig(id);
      });
    });
  }

  private editConfig(id: string) {
    const config = this.configs.find(c => c.id === id);
    if (!config) return;

    this.editingId = id;
    this.elements.nameInput.value = config.name;
    this.elements.urlInput.value = config.url;
    this.elements.bucketInput.value = config.gcpSecretName || '';
    this.elements.authCheckbox.checked = config.useDefaultAuth;
    
    // Limpar campos de header existentes
    this.clearHeaderFields();
    
    // Carregar headers existentes
    if (config.headers && config.headers.length > 0) {
      config.headers.forEach(header => {
        this.addHeaderField(header.name, header.value);
      });
    }
    
    this.elements.submitBtn.textContent = 'Atualizar Configuração';
    this.elements.cancelBtn.classList.remove('hidden');
    
    this.elements.nameInput.focus();
  }

  private async deleteConfig(id: string) {
    this.configs = this.configs.filter(c => c.id !== id);
    await this.saveConfigs();
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
      const handleSaveSetClick = async (e: Event) => {
        const target = e.target as HTMLElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;
        
        if (method && path && configId) {
          await this.saveValueSet(method, path, configId);
        }
      };
      btn.addEventListener('click', handleSaveSetClick);
    });

    // Adicionar event listeners para salvar conjuntos no bucket
    document.querySelectorAll('.save-set-bucket-btn').forEach(btn => {
      const handleSaveSetBucketClick = async (e: Event) => {
        const target = e.target as HTMLElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;
        
        if (method && path && configId) {
          await this.saveValueSet(method, path, configId, 'database');
        }
      };
      btn.addEventListener('click', handleSaveSetBucketClick);
    });

    // Adicionar event listeners para filtro de conjuntos
    document.querySelectorAll('.saved-sets-filter').forEach(filter => {
      filter.addEventListener('change', (e) => {
        const target = e.target as HTMLSelectElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;
        
        if (method && path && configId) {
          this.updateSavedSetsSelect(method, path, configId);
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
      btn.addEventListener('click', async (e) => {
        const target = e.target as HTMLElement;
        const method = target.dataset.method;
        const path = target.dataset.path;
        const configId = target.dataset.configId;
        
        if (method && path && configId) {
          await this.deleteValueSet(method, path, configId);
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

  private async saveValueSet(method: string, path: string, configId: string, saveType: 'local' | 'database' = 'local') {
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const nameInput = document.getElementById(`save-name-${method}-${pathId}`) as HTMLInputElement;
    const name = nameInput?.value?.trim();
    
    if (!name) {
      this.showToast('Por favor, digite um nome para este conjunto de valores.', 'error');
      return;
    }

    // Coletar path params atuais
    const pathParams: Record<string, string> = {};
    document.querySelectorAll(`[data-path-param="${method}-${pathId}"]`).forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      const value = (input as HTMLInputElement).value;
      if (param) {
        pathParams[param] = value;
      }
    });

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

    if (saveType === 'database') {
      // Salvar no bucket GCS
      const config = this.configs.find(c => c.id === configId);
      if (!config || !config.gcpSecretName) {
        this.showToast('Configuração não possui banco de dados configurado.', 'error');
        return;
      }

      try {
        // Obter conta do usuário para adicionar ao resultado
        const userAccount = await invoke<string>('get_gcloud_account');
        
        // Preparar dados para salvar no bucket
        const valueSetData = {
          id: Date.now().toString(),
          name,
          pathParams,
          queryParams,
          body,
          createdAt: new Date().toISOString(),
          endpoint: {
            method,
            path
          },
          userAccount,
          savedIn: 'bucket'
        };

        // Salvar no bucket
        const objectPath = await invoke<string>('save_value_set_to_postgres', {
          secretName: config.gcpSecretName,
          configId,
          endpointMethod: method,
          endpointPath: path,
          valueSetData
        });

        this.showToast(`Conjunto de valores salvo no banco de dados com sucesso! (${objectPath})`, 'success');
        
        // Atualizar o select para incluir os conjuntos do bucket
        this.updateSavedSetsSelect(method, path, configId);
        
      } catch (error) {
        console.error('Failed to save value set to GCS bucket:', error);
        this.showToast(`Erro ao salvar no bucket: ${String(error)}`, 'error');
      }
    } else {
      // Salvar localmente (código existente)
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
          pathParams,
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
          pathParams,
          queryParams,
          body,
          createdAt: new Date().toISOString()
        };

        // Adicionar o conjunto salvo
        this.savedValueSets[configId][method][path].push(savedSet);
        this.showToast('Conjunto de valores salvo com sucesso!', 'success');
      }
      
      // Salvar no app_data_dir
      await this.saveSavedValueSets();
      
      // Atualizar o select
      this.updateSavedSetsSelect(method, path, configId);
    }
  }

  private async loadValueSet(method: string, path: string, configId: string, savedSetId: string) {
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    
    // Verificar se é um conjunto do banco de dados ou local
    const isDatabaseSet = savedSetId.startsWith('database-');
    const actualId = isDatabaseSet ? savedSetId.substring(9) : savedSetId.substring(6); // Remove "database-" ou "local-"
    
    let savedSet: any;
    
    if (isDatabaseSet) {
      // Carregar conjunto do banco de dados
      try {
        const config = this.configs.find(c => c.id === configId);
        if (!config || !config.gcpSecretName) {
          this.showToast('Configuração não possui banco de dados configurado.', 'error');
          return;
        }
        
        const bucketSets = await invoke<Array<any>>('list_postgres_value_sets', {
          secretName: config.gcpSecretName,
          configId
        });
        
        // Filtrar apenas os conjuntos deste endpoint e encontrar o ID correspondente
        const endpointBucketSets = bucketSets.filter(set => 
          set.endpoint?.method === method && set.endpoint?.path === path
        );
        
        savedSet = endpointBucketSets.find(set => set.id === actualId);
        
        if (!savedSet) {
          console.error('Conjunto do bucket não encontrado:', actualId);
          return;
        }
      } catch (error) {
        console.error('Failed to load bucket value set:', error);
        this.showToast('Erro ao carregar conjunto do bucket.', 'error');
        return;
      }
    } else {
      // Carregar conjunto local
      savedSet = this.savedValueSets[configId]?.[method]?.[path]?.find(set => set.id === actualId);
      
      if (!savedSet) {
        console.error('Conjunto salvo não encontrado:', actualId);
        return;
      }
    }

    // Preencher path params
    Object.entries(savedSet.pathParams).forEach(([param, value]) => {
      const inputId = `path-param-${param}-${pathId}`;
      const input = document.getElementById(inputId) as HTMLInputElement;
      if (input) {
        input.value = String(value);
        input.setAttribute('value', String(value));
      }
    });

    // Preencher query params
    Object.entries(savedSet.queryParams).forEach(([param, value]) => {
      const inputId = `param-${param}-${pathId}`;
      const input = document.getElementById(inputId) as HTMLInputElement;
      if (input) {
        input.value = String(value);
        input.setAttribute('value', String(value));
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

  private async updateSavedSetsSelect(method: string, path: string, configId: string) {
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const select = document.getElementById(`saved-sets-${method}-${pathId}`) as HTMLSelectElement;
    const filter = document.getElementById(`saved-sets-filter-${method}-${pathId}`) as HTMLSelectElement;
    const loadingIndicator = document.getElementById(`loading-${method}-${pathId}`);
    
    if (!select || !filter) return;

    const filterType = filter.value;
    
    // Mostrar indicador de carregamento se estiver carregando do bucket
    if (filterType === 'todos' || filterType === 'database') {
      const config = this.configs.find(c => c.id === configId);
      if (config && config.gcpSecretName && loadingIndicator) {
        loadingIndicator.style.display = 'inline-flex';
      }
    }
    
    select.innerHTML = '<option value="">Selecione um conjunto salvo...</option>';
    
    // Adicionar conjuntos locais
    if (filterType === 'todos' || filterType === 'local') {
      const localSets = this.savedValueSets[configId]?.[method]?.[path] || [];
      localSets.forEach(savedSet => {
        const option = document.createElement('option');
        option.value = `local-${savedSet.id}`;
        option.textContent = `${savedSet.name} (${new Date(savedSet.createdAt).toLocaleDateString()}) [Local]`;
        select.appendChild(option);
      });
    }
    
    // Adicionar conjuntos do banco de dados
    if (filterType === 'todos' || filterType === 'database') {
      try {
        const config = this.configs.find(c => c.id === configId);
        if (config && config.gcpSecretName) {
          const bucketSets = await invoke<Array<any>>('list_postgres_value_sets', {
            secretName: config.gcpSecretName,
            configId
          });
          
          // Filtrar apenas os conjuntos deste endpoint
          const endpointBucketSets = bucketSets.filter(set => 
            set.endpoint?.method === method && set.endpoint?.path === path
          );
          
          endpointBucketSets.forEach(savedSet => {
            const option = document.createElement('option');
            option.value = `database-${savedSet.id}`;
            const userInfo = savedSet.userAccount ? ` [${savedSet.userAccount}]` : '';
            option.textContent = `${savedSet.name} (${new Date(savedSet.createdAt).toLocaleDateString()}) [Banco de Dados]${userInfo}`;
            select.appendChild(option);
          });
        }
      } catch (error) {
        console.error('Failed to load bucket value sets:', error);
        // Não mostrar erro ao usuário, apenas não carregar os conjuntos do bucket
      }
    }
    
    // Ocultar indicador de carregamento
    if (loadingIndicator) {
      loadingIndicator.style.display = 'none';
    }
  }

  private async deleteValueSet(method: string, path: string, configId: string) {
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const select = document.getElementById(`saved-sets-${method}-${pathId}`) as HTMLSelectElement;
    const selectedId = select?.value;
    
    if (!selectedId) {
      this.showToast('Por favor, selecione um conjunto para excluir.', 'error');
      return;
    }

    // Verificar se é um conjunto do banco de dados ou local
    const isDatabaseSet = selectedId.startsWith('database-');
    
    if (isDatabaseSet) {
      this.showToast('Conjuntos do banco de dados não podem ser excluídos diretamente. Use o console PostgreSQL para gerenciar os registros.', 'error');
      return;
    }

    const actualId = isDatabaseSet ? selectedId.substring(9) : selectedId.substring(6); // Remove "database-" ou "local-"
    const savedSet = this.savedValueSets[configId]?.[method]?.[path]?.find(set => set.id === actualId);
    
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
    const index = sets.findIndex(set => set.id === actualId);
    
    if (index !== -1) {
      sets.splice(index, 1);
      
      // Salvar no app_data_dir
      await this.saveSavedValueSets();
      
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

  private attachResultEventListeners(method: string, path: string, configId: string, _pathParams: Record<string, string>, queryParams: Record<string, string>, body: string, response: TestResponse, timestamp: string, sentUuid?: string) {
    // Event listeners para salvar teste (local e bucket)
    const saveBtns = document.querySelectorAll(`[data-method="${method}"][data-path="${path}"][data-config-id="${configId}"].save-result-btn`) as NodeListOf<HTMLButtonElement>;
    saveBtns.forEach(saveBtn => {
      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          const saveType = saveBtn.dataset.saveType as 'local' | 'database';
          await this.saveTestResult(method, path, configId, queryParams, body, response, timestamp, saveType, sentUuid);
        });
      }
    });

    // Event listener para exibir histórico
    const historyBtn = document.querySelector(`[data-method="${method}"][data-path="${path}"][data-config-id="${configId}"].show-history-btn`) as HTMLButtonElement;
    if (historyBtn) {
      historyBtn.addEventListener('click', () => {
        this.showHistoryModal(configId);
      });
    }
  }

  private setupResponseSearch(method: string, path: string, _configId: string) {
    // Event listeners para busca específica da resposta
    // Usar a mesma lógica de geração de pathId do executeTest
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    
    // IDs esperados
    const expectedSearchInputId = `response-search-${pathId}`;
    const expectedResponseContainerId = `response-${pathId}`;
    const expectedSearchInfoId = `response-search-info-${pathId}`;
    
    // Tentar encontrar os elementos
    const searchInput = document.getElementById(expectedSearchInputId) as HTMLInputElement;
    const clearBtn = document.querySelector(`[data-search-input="${expectedSearchInputId}"]`) as HTMLButtonElement;
    const responseContainer = document.getElementById(expectedResponseContainerId) as HTMLPreElement;
    const searchInfo = document.getElementById(expectedSearchInfoId) as HTMLDivElement;

    if (searchInput && clearBtn && responseContainer && searchInfo) {
      let currentMatchIndex = 0;
      let matches: HTMLElement[] = [];
      let originalContent = responseContainer.innerHTML;

      const performSearch = () => {
        const searchTerm = searchInput.value.trim();
        
        if (!searchTerm) {
          this.clearResponseHighlights(responseContainer, originalContent);
          searchInfo.textContent = '';
          matches = [];
          currentMatchIndex = 0;
          return;
        }

        const content = responseContainer.textContent || '';
        const searchRegex = new RegExp(searchTerm, 'gi');
        
        if (searchRegex.test(content)) {
          this.highlightResponseMatches(responseContainer, searchTerm, currentMatchIndex);
          matches = Array.from(responseContainer.querySelectorAll('.response-highlight'));
          searchInfo.textContent = matches.length > 0 ? `${currentMatchIndex + 1} de ${matches.length}` : 'Nenhum resultado';
        } else {
          this.clearResponseHighlights(responseContainer, originalContent);
          searchInfo.textContent = 'Nenhum resultado';
          matches = [];
        }
      };

      const navigateResults = (direction: number) => {
        if (matches.length === 0) return;
        
        currentMatchIndex = (currentMatchIndex + direction + matches.length) % matches.length;
        searchInfo.textContent = `${currentMatchIndex + 1} de ${matches.length}`;
        this.scrollToResponseMatch(matches[currentMatchIndex]);
      };

      // Event listeners
      searchInput.addEventListener('input', performSearch);
      
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) {
            navigateResults(-1);
          } else {
            navigateResults(1);
          }
        } else if (e.key === 'Escape') {
          searchInput.value = '';
          performSearch();
        }
      });

      clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        performSearch();
        searchInput.focus();
      });
    }
  }

  private async saveTestResult(method: string, path: string, configId: string, queryParams: Record<string, string>, body: string, response: TestResponse, timestamp: string, saveType: 'local' | 'database' = 'local', sentUuid?: string) {
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const nameInput = document.getElementById(`result-name-${pathId}`) as HTMLInputElement;
    const name = nameInput?.value?.trim();
    
    if (!name) {
      this.showToast('Por favor, digite um nome para este resultado.', 'error');
      return;
    }

    // Coletar path params atuais
    const pathParams: Record<string, string> = {};
    document.querySelectorAll(`[data-path-param="${method}-${pathId}"]`).forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      const value = (input as HTMLInputElement).value;
      if (param) {
        pathParams[param] = value;
      }
    });

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
        pathParams,
        queryParams,
        body,
        sentUuid // UUID enviado no header da requisição
      },
      response: {
        status: response.status || 200,
        statusText: response.statusText || 'OK',
        headers: response.headers || {},
        data: response.data
      },
      timestamp,
      storageLocation: saveType
    };

    if (saveType === 'database') {
      // Salvar no bucket GCS
      const config = this.configs.find(c => c.id === configId);
      if (!config || !config.gcpSecretName) {
        this.showToast('Configuração não possui banco de dados configurado.', 'error');
        return;
      }

      try {
        // Usar usuário cacheado ou obter se não disponível
        let userAccount = this.cachedGcloudUser;
        if (!userAccount) {
          userAccount = await invoke<string>('get_gcloud_account');
          this.cachedGcloudUser = userAccount; // Atualizar cache
        }
        
        // Adicionar informação do usuário ao resultado
        savedResult.userAccount = userAccount;

        // Salvar no bucket
        await invoke<string>('save_to_postgres', {
          secretName: config.gcpSecretName,
          configId,
          endpointMethod: method,
          endpointPath: path,
          resultData: savedResult
        });

        this.showToast(`Resultado salvo no bucket "${config.gcpSecretName}" com sucesso!`, 'success');
        
        // Refresh history modal if it's open
        const historyModal = document.querySelector('.history-modal') as HTMLElement;
        if (historyModal) {
          const select = document.querySelector('#history-endpoint-select') as HTMLSelectElement;
          const searchInput = document.getElementById('history-search-input') as HTMLInputElement;
          const searchFilter = searchInput?.value || '';
          const endpointFilter = select?.value || '';
          const sourceSelect = document.querySelector('#history-source-select') as HTMLSelectElement;
          const sourceFilter = sourceSelect?.value || 'todos';
          await this.displayHistoryResults(configId, endpointFilter, searchFilter, '', sourceFilter);
        }
      } catch (error) {
        console.error('Failed to save to GCS bucket:', error);
        this.showToast(`Erro ao salvar no bucket: ${String(error)}`, 'error');
      }
    } else {
      // Salvar localmente (código existente)
      if (!this.savedResults[configId]) {
        this.savedResults[configId] = [];
      }

      this.savedResults[configId].push(savedResult);
      await this.saveSavedResults();
      this.showToast('Resultado salvo localmente com sucesso!', 'success');
      
      // Refresh history modal if it's open
      const historyModal = document.querySelector('.history-modal') as HTMLElement;
      if (historyModal) {
        const select = document.querySelector('#history-endpoint-select') as HTMLSelectElement;
        const searchInput = document.getElementById('history-search-input') as HTMLInputElement;
        const searchFilter = searchInput?.value || '';
        const endpointFilter = select?.value || '';
        const sourceSelect = document.querySelector('#history-source-select') as HTMLSelectElement;
        const sourceFilter = sourceSelect?.value || 'todos';
        await this.displayHistoryResults(configId, endpointFilter, searchFilter, '', sourceFilter);
      }
    }
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
          <div class="history-controls-row">
            <div class="history-control-group">
              <label for="history-endpoint-select">Selecione o endpoint:</label>
              <select id="history-endpoint-select" class="history-endpoint-select">
                <option value="">Todos os endpoints</option>
              </select>
            </div>
            <div class="history-control-group">
              <label for="history-user-select">Filtrar por usuário:</label>
              <select id="history-user-select" class="history-user-select">
                <option value="">Todos os usuários</option>
              </select>
            </div>
            <div class="history-control-group">
              <label for="history-source-select">Origem do histórico:</label>
              <select id="history-source-select" class="history-source-select">
                <option value="todos">Todos</option>
                <option value="local">Apenas local</option>
                <option value="bucket">Apenas bucket</option>
              </select>
            </div>
          </div>
          <div class="history-controls">
            <label for="history-search-input">Buscar nos resultados:</label>
            <div class="history-search-container">
              <input type="text" 
                     id="history-search-input" 
                     class="history-search-input" 
                     placeholder="Buscar no nome, endpoint ou conteúdo...">
              <button class="history-search-clear" title="Limpar busca">×</button>
            </div>
            <div class="history-search-info" id="history-search-info"></div>
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

  private async populateHistoryEndpoints(configId: string) {
    const endpointSelect = document.getElementById('history-endpoint-select') as HTMLSelectElement;
    const userSelect = document.getElementById('history-user-select') as HTMLSelectElement;
    
    if (!endpointSelect || !userSelect) return;

    // Mostrar indicadores de carregamento nos selects
    endpointSelect.innerHTML = '<option value="">Carregando...</option>';
    userSelect.innerHTML = '<option value="">Carregando...</option>';
    
    // Coletar endpoints e usuários de TODOS os resultados (locais + bucket)
    const config = this.configs.find(c => c.id === configId);
    const allResults: SavedResult[] = [];
    const endpoints = new Set<string>();
    const users = new Set<string>();
    
    // Adicionar resultados locais
    const localResults = this.savedResults[configId] || [];
    allResults.push(...localResults.map(r => ({ ...r, storageLocation: 'local' as const })));
    
    // Adicionar resultados do bucket se configurado
    if (config && config.gcpSecretName) {
      try {
        const bucketResults = await invoke<SavedResult[]>('list_postgres_results', {
          secretName: config.gcpSecretName,
          configId
        });
        
        // Marcar resultados do bucket
        const bucketResultsWithLocation = bucketResults.map(r => ({ 
          ...r, 
          storageLocation: 'database' as const,
          userAccount: r.userAccount || 'unknown'
        }));
        
        allResults.push(...bucketResultsWithLocation);
      } catch (error) {
        console.error('Failed to load bucket results:', error);
        // Não mostrar erro ao usuário, apenas não incluir resultados do bucket
      }
    }
    
    // Coletar endpoints e usuários únicos de TODOS os resultados
    let currentUserGcloudAccount: string | null = null;
    
    // Obter conta gcloud atual para resultados locais
    try {
      currentUserGcloudAccount = await this.getCurrentUserName();
    } catch (error) {
      console.warn('Could not get current gcloud account:', error);
    }
    
    allResults.forEach(result => {
      const endpointKey = `${result.endpoint.method} ${result.endpoint.path}`;
      endpoints.add(endpointKey);
      
      // Para resultados locais, usar a conta gcloud atual como usuário
      // Para resultados do bucket, usar o userAccount salvo
      const userAccount = result.storageLocation === 'local' 
        ? currentUserGcloudAccount 
        : result.userAccount;
        
      if (userAccount) {
        users.add(userAccount);
      }
    });
    
    // Popular select de endpoints
    endpointSelect.innerHTML = '<option value="">Todos os endpoints</option>';
    endpoints.forEach(endpoint => {
      const option = document.createElement('option');
      option.value = endpoint;
      option.textContent = endpoint;
      endpointSelect.appendChild(option);
    });
    
    // Popular select de usuários
    userSelect.innerHTML = '<option value="">Todos os usuários</option>';
    
    // Adicionar usuários em ordem alfabética
    const sortedUsers = Array.from(users).filter(user => user && user !== 'desconhecido').sort();
    sortedUsers.forEach(user => {
      const option = document.createElement('option');
      option.value = user;
      option.textContent = `👤 ${user}`;
      userSelect.appendChild(option);
    });
  }

  private getCurrentUserName(): Promise<string> {
    // Retornar valor cacheado se disponível
    if (this.cachedGcloudUser) {
      return Promise.resolve(this.cachedGcloudUser);
    }
    
    // Fallback: tentar obter o nome do usuário atual do sistema
    try {
      return invoke<string>('get_gcloud_account');
    } catch (error) {
      console.warn('Could not get current user:', error);
      return Promise.resolve('desconhecido');
    }
  }

  private async setupHistoryModalListeners(modal: HTMLElement, configId: string) {
    // Fechar modal
    const closeBtn = modal.querySelector('.close-btn') as HTMLButtonElement;
    closeBtn.addEventListener('click', () => {
      this.closeHistoryModal(modal);
    });

    // Fechar clicando fora
    modal.addEventListener('click', async (e) => {
      if (e.target === modal) {
        await this.closeHistoryModal(modal);
      }
    });

    // Event listeners para os campos de filtro
    const searchInput = modal.querySelector('#history-search-input') as HTMLInputElement;
    const clearBtn = modal.querySelector('.history-search-clear') as HTMLButtonElement;
    const endpointSelect = modal.querySelector('#history-endpoint-select') as HTMLSelectElement;
    const userSelect = modal.querySelector('#history-user-select') as HTMLSelectElement;
    const sourceSelect = modal.querySelector('#history-source-select') as HTMLSelectElement;
    
    if (searchInput && clearBtn && endpointSelect && userSelect && sourceSelect) {
      const performHistorySearch = async () => {
        const searchFilter = searchInput.value.trim();
        const endpointFilter = endpointSelect.value;
        const userFilter = userSelect.value;
        const sourceFilter = sourceSelect.value;
        await this.displayHistoryResults(configId, endpointFilter, searchFilter, userFilter, sourceFilter);
        
        // Re-adicionar listeners para os novos botões
        this.attachCopyButtonsListeners();
        modal.querySelectorAll('.delete-result-btn').forEach((btn) => {
          btn.addEventListener('click', async e => {
            e.stopPropagation();
            const target = e.target as HTMLElement;
            const resultId = target.dataset.resultId;
            const btnConfigId = target.dataset.configId;
            
            if (resultId && btnConfigId) {
              await this.deleteSavedResult(resultId, btnConfigId);
            }
          });
        });
      };

      // Event listeners para busca e usuário
      searchInput.addEventListener('input', performHistorySearch);
      userSelect.addEventListener('change', performHistorySearch);
      sourceSelect.addEventListener('change', performHistorySearch);
      
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          searchInput.value = '';
          performHistorySearch();
        }
      });

      clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        performHistorySearch();
        searchInput.focus();
      });
    }

    // Exibir todos os resultados inicialmente
    await this.displayHistoryResults(configId, '', '', '', 'todos');
    
    // Adicionar event listeners para os botões de copiar
    this.attachCopyButtonsListeners();
    
    // Adicionar event listeners para os botões de exclusão
    modal.querySelectorAll('.delete-result-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const target = e.target as HTMLElement;
        const resultId = target.dataset.resultId;
        const btnConfigId = target.dataset.configId;
        
        if (resultId && btnConfigId) {
          await this.deleteSavedResult(resultId, btnConfigId);
        }
      });
    });

    // Adicionar event listeners para busca individual em cada resultado
    this.setupHistoryResponseSearchListeners(configId);
  }

  private setupHistoryResponseSearchListeners(configId: string) {
    // Configurar busca para cada resultado individual no histórico
    const results = this.savedResults[configId] || [];
    
    results.forEach(result => {
      const searchInput = document.getElementById(`history-response-search-${result.id}`) as HTMLInputElement;
      const clearBtn = document.querySelector(`[data-search-input="history-response-search-${result.id}"]`) as HTMLButtonElement;
      const responseContainer = document.getElementById(`history-response-${result.id}`) as HTMLPreElement;
      const searchInfo = document.getElementById(`history-response-search-info-${result.id}`) as HTMLDivElement;

      if (searchInput && clearBtn && responseContainer && searchInfo) {
        let currentMatchIndex = 0;
        let matches: HTMLElement[] = [];
        let originalContent = responseContainer.innerHTML;

        const performSearch = () => {
          const searchTerm = searchInput.value.trim();
          
          if (!searchTerm) {
            // Restaurar conteúdo original
            responseContainer.innerHTML = originalContent;
            searchInfo.textContent = '';
            matches = [];
            currentMatchIndex = 0;
            return;
          }

          const content = responseContainer.textContent || '';
          const searchRegex = new RegExp(searchTerm, 'gi');
          
          if (searchRegex.test(content)) {
            // Salvar conteúdo original se ainda não foi salvo
            if (!responseContainer.dataset.originalContent) {
              responseContainer.dataset.originalContent = originalContent;
            }
            
            // Aplicar highlights
            this.highlightResponseMatches(responseContainer, searchTerm, currentMatchIndex);
            matches = Array.from(responseContainer.querySelectorAll('.response-highlight'));
            searchInfo.textContent = matches.length > 0 ? `${currentMatchIndex + 1} de ${matches.length}` : 'Nenhum resultado';
          } else {
            // Restaurar conteúdo original
            if (responseContainer.dataset.originalContent) {
              responseContainer.innerHTML = responseContainer.dataset.originalContent;
            }
            searchInfo.textContent = 'Nenhum resultado';
            matches = [];
          }
        };

        const navigateResults = (direction: number) => {
          if (matches.length === 0) return;
          
          currentMatchIndex = (currentMatchIndex + direction + matches.length) % matches.length;
          searchInfo.textContent = `${currentMatchIndex + 1} de ${matches.length}`;
          this.scrollToResponseMatch(matches[currentMatchIndex]);
        };

        // Event listeners
        searchInput.addEventListener('input', performSearch);
        
        searchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
              navigateResults(-1);
            } else {
              navigateResults(1);
            }
          } else if (e.key === 'Escape') {
            searchInput.value = '';
            performSearch();
          }
        });

        clearBtn.addEventListener('click', () => {
          searchInput.value = '';
          performSearch();
          searchInput.focus();
        });
      }
    });
  }

  private async closeHistoryModal(modal: HTMLElement) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    setTimeout(() => {
      document.body.removeChild(modal);
    }, 300);
  }

  private async displayHistoryResults(configId: string, endpointFilter: string, searchFilter: string = '', userFilter: string = '', sourceFilter: string = 'todos') {
    const listContainer = document.querySelector('.history-list') as HTMLElement;
    if (!listContainer) return;

    // Mostrar indicador de carregamento
    listContainer.innerHTML = `
      <div class="history-loading">
        <div class="loading-spinner"></div>
        <p>Carregando resultados...</p>
      </div>
    `;

    const config = this.configs.find(c => c.id === configId);
    let allResults: SavedResult[] = [];

    // Adicionar resultados locais (apenas se sourceFilter for 'todos' ou 'local')
    if (sourceFilter === 'todos' || sourceFilter === 'local') {
      const localResults = this.savedResults[configId] || [];
      allResults.push(...localResults.map(r => ({ ...r, storageLocation: r.storageLocation || 'local' as const })));
    }

    // Adicionar resultados do bucket se configurado (apenas se sourceFilter for 'todos' ou 'bucket')
    if ((sourceFilter === 'todos' || sourceFilter === 'database') && config && config.gcpSecretName) {
      try {
        const bucketResults = await invoke<SavedResult[]>('list_postgres_results', {
          secretName: config.gcpSecretName,
          configId
        });
        
        // Marcar resultados do bucket
        const bucketResultsWithLocation = bucketResults.map(r => ({ 
          ...r, 
          storageLocation: 'database' as const,
          userAccount: r.userAccount || 'unknown'
        }));
        
        allResults.push(...bucketResultsWithLocation);
      } catch (error) {
        console.error('Failed to load bucket results:', error);
        // Não mostrar erro ao usuário, apenas não incluir resultados do bucket
      }
    }

    // Filtrar por endpoint se necessário
    let filteredResults = endpointFilter 
      ? allResults.filter(result => `${result.endpoint.method} ${result.endpoint.path}` === endpointFilter)
      : allResults;

    // Filtrar por termo de busca se necessário
    if (searchFilter) {
      const searchLower = searchFilter.toLowerCase();
      filteredResults = filteredResults.filter(result => {
        // Buscar no nome
        if (result.name.toLowerCase().includes(searchLower)) return true;
        
        // Buscar no endpoint
        const endpointKey = `${result.endpoint.method} ${result.endpoint.path}`;
        if (endpointKey.toLowerCase().includes(searchLower)) return true;
        
        // Buscar no conteúdo da resposta
        const responseContent = typeof result.response.data === 'string' 
          ? result.response.data 
          : JSON.stringify(result.response.data);
        if (responseContent.toLowerCase().includes(searchLower)) return true;
        
        // Buscar nos query params
        if (result.request.queryParams) {
          const queryParamsStr = JSON.stringify(result.request.queryParams);
          if (queryParamsStr.toLowerCase().includes(searchLower)) return true;
        }
        
        // Buscar nos path params
        if (result.request.pathParams) {
          const pathParamsStr = JSON.stringify(result.request.pathParams);
          if (pathParamsStr.toLowerCase().includes(searchLower)) return true;
        }
        
        // Buscar no UUID enviado
        if (result.request.sentUuid && result.request.sentUuid.toLowerCase().includes(searchLower)) return true;
        
        // Buscar no body
        if (result.request.body && result.request.body.toLowerCase().includes(searchLower)) return true;
        
        // Buscar nos headers
        if (result.response.headers) {
          const headersStr = JSON.stringify(result.response.headers);
          if (headersStr.toLowerCase().includes(searchLower)) return true;
        }
        
        // Buscar na conta do usuário (para resultados do bucket)
        if (result.userAccount && result.userAccount.toLowerCase().includes(searchLower)) return true;
        
        return false;
      });
    }

    // Filtrar por usuário se necessário
    if (userFilter) {
      // Obter conta gcloud atual para comparar com resultados locais
      let currentUserGcloudAccount: string | null = null;
      try {
        currentUserGcloudAccount = await this.getCurrentUserName();
      } catch (error) {
        console.warn('Could not get current gcloud account for filtering:', error);
      }
      
      filteredResults = filteredResults.filter(result => {
        // Para resultados locais, mostrar apenas se o filtro corresponder à conta gcloud atual
        if (result.storageLocation === 'local') {
          return currentUserGcloudAccount === userFilter;
        }
        
        // Para resultados do bucket, verificar userAccount
        if (result.storageLocation === 'database' && result.userAccount) {
          return result.userAccount === userFilter;
        }
        
        // Se não houver correspondência, não mostrar
        return false;
      });
    }

    // Ordenar do mais recente para o mais antigo
    const sortedResults = filteredResults.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    if (sortedResults.length === 0) {
      const emptyMessage = searchFilter 
        ? `Nenhum resultado encontrado para "${searchFilter}".`
        : endpointFilter 
          ? 'Nenhum resultado encontrado para este endpoint.'
          : 'Nenhum resultado encontrado.';
      listContainer.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
      
      // Atualizar contador de resultados
      const searchInfo = document.getElementById('history-search-info') as HTMLDivElement;
      if (searchInfo) {
        searchInfo.textContent = searchFilter ? `0 resultados` : '';
      }
      return;
    }

    // Destacar o termo de busca nos resultados
    const highlightSearchTerm = (text: string) => {
      if (!searchFilter) return this.escapeHtml(text);
      
      // Função para escapar caracteres especiais na regex
      const escapeRegex = (str: string): string => {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      };
      
      const escapedSearchFilter = escapeRegex(searchFilter);
      const regex = new RegExp(`(${escapedSearchFilter})`, 'gi');
      return this.escapeHtml(text).replace(regex, '<span class="history-search-highlight">$1</span>');
    };

    listContainer.innerHTML = sortedResults.map(result => `
      <div class="history-item collapsed" data-result-id="${result.id}" data-storage-location="${result.storageLocation || 'local'}">
        <div id="result-name-${result.id}" style="display: none;">${this.escapeHtml(result.name)}</div>
        <div class="history-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <div class="history-title">
            <div class="title-with-copy">
              <h4>${highlightSearchTerm(result.name)}</h4>
              <button class="copy-btn copy-title-btn" data-target="result-name-${result.id}" title="Copiar nome do resultado" onclick="event.stopPropagation()">❐</button>
            </div>
            <div class="history-meta">
              <span class="history-endpoint">${highlightSearchTerm(`${result.endpoint.method} ${result.endpoint.path}`)}</span>
              <span class="history-timestamp">${new Date(result.timestamp).toLocaleString('pt-BR')}</span>
              ${result.storageLocation === 'database' ? `
                <span class="history-storage-indicator database" title="Salvo no banco de dados">
                  🗂️ Banco de Dados
                </span>
                ${result.userAccount ? `
                  <span class="history-user" title="Salvo por: ${result.userAccount}">
                    👤 ${highlightSearchTerm(result.userAccount)}
                  </span>
                ` : ''}
              ` : `
                <span class="history-storage-indicator local" title="Salvo localmente">
                  💻 Local
                </span>
              `}
            </div>
          </div>
          <div class="history-actions">
            ${result.storageLocation === 'local' ? `
              <button 
                class="delete-result-btn" 
                data-result-id="${result.id}"
                data-config-id="${configId}"
                title="Excluir resultado"
                onclick="event.stopPropagation()"
              >
                🗑️
              </button>
            ` : `
              <span class="bucket-result-info" title="Resultados do bucket não podem ser excluídos localmente">
                🗂️
              </span>
            `}
            <span class="history-expand-icon">▶</span>
          </div>
        </div>
        <div class="history-content">
          <div class="history-content-inner">
            <div class="history-request">
              <h5>Request:</h5>
              ${Object.keys(result.request.pathParams).length > 0 ? `
                <div class="history-section">
                  <div class="section-header">
                    <p><strong>Path Params:</strong></p>
                    <button class="copy-btn" data-target="history-path-${result.id}">📋 Copiar</button>
                  </div>
                  <pre id="history-path-${result.id}">${this.escapeHtml(JSON.stringify(result.request.pathParams, null, 2))}</pre>
                </div>
              ` : ''}
              ${Object.keys(result.request.queryParams).length > 0 ? `
                <div class="history-section">
                  <div class="section-header">
                    <p><strong>Query Params:</strong></p>
                    <button class="copy-btn" data-target="history-query-${result.id}">📋 Copiar</button>
                  </div>
                  <pre id="history-query-${result.id}">${this.escapeHtml(JSON.stringify(result.request.queryParams, null, 2))}</pre>
                </div>
              ` : ''}
              ${result.request.sentUuid ? `
                <div class="history-section">
                  <div class="section-header">
                    <p><strong>UUID Enviado:</strong></p>
                    <button class="copy-btn" data-target="history-uuid-${result.id}">📋 Copiar</button>
                  </div>
                  <pre id="history-uuid-${result.id}">${this.escapeHtml(result.request.sentUuid)}</pre>
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
                <div class="history-response-search-container">
                  <div class="history-response-search-header">
                    <input type="text" 
                           id="history-response-search-${result.id}" 
                           class="history-response-search-input" 
                           placeholder="Buscar nesta resposta..." 
                           data-response-id="history-response-${result.id}">
                    <button class="history-response-search-clear" data-search-input="history-response-search-${result.id}" title="Limpar busca">×</button>
                  </div>
                  <div class="history-response-search-info" id="history-response-search-info-${result.id}"></div>
                </div>
                <pre id="history-response-${result.id}">${this.escapeHtml(typeof result.response.data === 'string' ? result.response.data : JSON.stringify(result.response.data, null, 2))}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    `).join('');

    // Atualizar contador de resultados
    const searchInfo = document.getElementById('history-search-info') as HTMLDivElement;
    if (searchInfo) {
      searchInfo.textContent = searchFilter ? `${sortedResults.length} resultado${sortedResults.length !== 1 ? 's' : ''}` : '';
    }
  }

  private async executeTest(method: string, path: string, configId: string) {
    const config = this.configs.find(c => c.id === configId);
    if (!config) return;

    // Coletar path params e substituir na URL
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const pathParams: Record<string, string> = {};
    document.querySelectorAll(`[data-path-param="${method}-${pathId}"]`).forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      const value = (input as HTMLInputElement).value;
      if (param) {
        pathParams[param] = value;
      }
    });

    // Substituir path parameters na URL
    let processedPath = path;
    Object.entries(pathParams).forEach(([param, value]) => {
      processedPath = processedPath.replace(`{${param}}`, encodeURIComponent(value));
    });

    // Coletar query params
    const queryParams: Record<string, string> = {};
    document.querySelectorAll(`[data-query-param="${method}-${pathId}"]`).forEach(input => {
      const param = (input as HTMLInputElement).dataset.param;
      const value = (input as HTMLInputElement).value;
      if (param) {
        queryParams[param] = value;
      }
    });

    // Coletar body
    const bodyTextarea = document.getElementById(`body-${method}-${pathId}`) as HTMLTextAreaElement;
    const body = bodyTextarea?.value || '';
    
    const testResult = document.getElementById(`test-result-${method}-${pathId}`);
    if (!testResult) return;
    
    testResult.innerHTML = '<div class="test-loading">Executando teste...</div>';

    try {
      const baseUrl = config.url.replace(/\/$/, '');
      const queryString = Object.keys(queryParams).length > 0 
        ? '?' + Object.entries(queryParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
        : '';
      
      const fullUrl = `${baseUrl}${processedPath}${queryString}`;

      // Processar headers personalizados com suporte a UUID
      const processedHeaders: Record<string, string> = {};
      let sentUuid: string | undefined; // Capturar UUID enviado no header
      
      if (config.headers && config.headers.length > 0) {
        config.headers.forEach(header => {
          if (header.name && header.value) {
            // Se o valor for exatamente "uuid", gerar um UUID
            if (header.value.toLowerCase() === 'uuid') {
              const uuid = this.generateUUID();
              processedHeaders[header.name] = uuid;
              sentUuid = uuid; // Armazenar UUID enviado
            } else {
              processedHeaders[header.name] = header.value;
            }
          }
        });
      }

      // Usar o proxy Tauri para fazer a requisição com autenticação e headers
      const response: TestResponse = await invoke('make_test_request', {
        url: fullUrl,
        method: method.toUpperCase(),
        body: body,
        useAuth: config.useDefaultAuth,
        headers: processedHeaders
      });

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
                    id="result-name-${pathId}"
                    class="result-name-input"
                    placeholder="Nome do resultado..."
                    value="Resultado_${new Date().toLocaleString('pt-BR').replace(/[^\w]/g, '_')}"
                  />
                  <div class="save-buttons-row">
                    <button 
                      class="save-result-btn save-local-btn" 
                      data-method="${method}"
                      data-path="${path}"
                      data-config-id="${configId}"
                      data-timestamp="${timestamp}"
                      data-save-type="local"
                    >
                      Salvar local
                    </button>
                    <button 
                      class="save-result-btn save-bucket-btn" 
                      data-method="${method}"
                      data-path="${path}"
                      data-config-id="${configId}"
                      data-timestamp="${timestamp}"
                      data-save-type="bucket"
                      title="Salvar no bucket GCS"
                    >
                      Salvar no bucket
                    </button>
                  </div>
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
                  <p><strong>Response Headers:</strong></p>
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
              <button class="copy-btn" data-target="response-${pathId}">📋 Copiar</button>
            </div>
            <div class="response-search-container">
              <div class="response-search-header">
                <input type="text" 
                       id="response-search-${pathId}" 
                       class="response-search-input" 
                       placeholder="Buscar na resposta..." 
                       data-response-id="response-${pathId}">
                <button class="response-search-clear" data-search-input="response-search-${pathId}" title="Limpar busca">×</button>
              </div>
              <div class="response-search-info" id="response-search-info-${pathId}"></div>
            </div>
            <pre id="response-${pathId}" class="test-response-data">${this.escapeHtml(typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2))}</pre>
          </div>
        </div>
      `;

      // Configurar event listeners para busca SEMPRE (independentemente de ter dados para salvar)
      requestAnimationFrame(() => {
        setTimeout(() => {
          this.setupResponseSearch(method, path, configId);
        }, 50);
      });

      // Adicionar event listeners para os novos botões (apenas se houver dados)
      if (hasData) {
        this.attachResultEventListeners(method, path, configId, pathParams, queryParams, body, response, timestamp, sentUuid);
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

  private generateTestInterface(method: string, details: any, path: string, spec: any, configId: string): string {
    const queryParams = details.parameters?.filter((param: any) => param.in === 'query') || [];
    const pathParams = details.parameters?.filter((param: any) => param.in === 'path') || [];
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());
    const exampleBody = this.generateExampleBody(details, spec);
    const pathId = `${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    
    // Verificar se há algo para salvar (path params, query params ou body)
    const hasAnythingToSave = pathParams.length > 0 || queryParams.length > 0 || hasBody;
    
    // Armazenar valor padrão no mapa
    const bodyKey = `${method}-${pathId}`;
    this.defaultBodyValues.set(bodyKey, exampleBody);

    return `
      <div class="test-interface">
        ${pathParams.length > 0 ? `
          <div class="path-params">
            <div class="section-header">
              <h6>Path Parameters:</h6>
              <button class="reset-btn" data-reset="path-${method}-${pathId}" title="Resetar Path Params">🔄</button>
            </div>
            ${pathParams.map((param: any) => `
              <div class="param-input">
                <label for="path-param-${param.name}-${pathId}">
                  ${this.escapeHtml(param.name)} ${param.required ? '<span class="required">*</span>' : ''}
                </label>
                <input 
                  type="text" 
                  id="path-param-${param.name}-${pathId}"
                  data-path-param="${method}-${pathId}"
                  data-param="${param.name}"
                  data-default="${this.escapeHtml(param.schema?.default?.toString() || '')}"
                  placeholder="${this.escapeHtml(param.description || `Digite ${param.name}...`)}"
                  value="${this.escapeHtml(param.schema?.default?.toString() || '')}"
                  ${param.required ? 'required' : ''}
                />
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${queryParams.length > 0 ? `
          <div class="query-params">
            <div class="section-header">
              <h6>Query Parameters:</h6>
              <button class="reset-btn" data-reset="query-${method}-${pathId}" title="Resetar Query Params">🔄</button>
            </div>
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
                  data-default="${this.escapeHtml(param.schema?.default?.toString() || '')}"
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
            <div class="section-header">
              <h6>Body (JSON):</h6>
              <button class="reset-btn" data-reset="body-${method}-${pathId}" title="Resetar Body">🔄</button>
            </div>
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
            data-config-id="${configId}"
          >
            Testar ${method.toUpperCase()}
          </button>
        </div>
        
        ${hasAnythingToSave ? `
        <div class="saved-sets-section">
          <h6>Conjuntos de Valores Salvos:</h6>
          <div class="save-set-controls">
            <input 
              type="text" 
              id="save-name-${method}-${pathId}"
              placeholder="Nome do conjunto"
              class="save-name-input"
            />
            <button 
              class="save-set-btn" 
              data-method="${method}"
              data-path="${path}"
              data-config-id="${configId}"
            >
              Salvar Local
            </button>
            <button 
              class="save-set-bucket-btn" 
              data-method="${method}"
              data-path="${path}"
              data-config-id="${configId}"
              title="Salvar no bucket GCS"
            >
              Salvar no bucket
            </button>
          </div>
          <div class="load-set-controls">
            <label for="saved-sets-${method}-${pathId}">Carregar conjunto:</label>
            <div class="load-set-row">
              <select 
                id="saved-sets-filter-${method}-${pathId}"
                class="saved-sets-filter"
                data-method="${method}"
                data-path="${path}"
                data-config-id="${configId}"
              >
                <option value="todos">Todos</option>
                <option value="local">Local</option>
                <option value="bucket">Bucket</option>
              </select>
              <select 
                id="saved-sets-${method}-${pathId}"
                class="saved-sets-select"
                data-method="${method}"
                data-path="${path}"
                data-config-id="${configId}"
              >
                <option value="">Selecione um conjunto salvo...</option>
              </select>
              <button 
                class="delete-set-btn" 
                data-method="${method}"
                data-path="${path}"
                data-config-id="${configId}"
                title="Excluir conjunto selecionado"
              >
                🗑️
              </button>
              <div id="loading-${method}-${pathId}" class="loading-indicator" style="display: none;">
                <div class="loading-spinner"></div>
                Carregando...
              </div>
            </div>
          </div>
        </div>
        ` : ''}
        
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

  private async updateWindowTitle() {
    try {
      const currentConfigId = this.getCurrentConfigId();
      let title = 'OpenAPIUI';
      
      if (currentConfigId) {
        const config = this.configs.find(c => c.id === currentConfigId);
        if (config) {
          title = `OpenAPIUI - ${config.name}`;
        }
      }
      
      await getCurrentWindow().setTitle(title);
    } catch (error) {
      console.error('Failed to update window title:', error);
    }
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

  private async deleteSavedResult(resultId: string, configId: string) {
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
    const sourceSelect = document.querySelector('#history-source-select') as HTMLSelectElement;
    await this.displayHistoryResults(configId, select?.value || '', '', '', sourceSelect?.value || 'todos');
    
    this.showToast('Resultado excluído com sucesso!', 'success');
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private async loadTheme() {
    try {
      const savedTheme = localStorage.getItem(this.THEME_KEY);
      if (savedTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        this.elements.themeToggleBtn.textContent = '🌙 Tema Escuro';
      } else {
        document.documentElement.removeAttribute('data-theme');
        this.elements.themeToggleBtn.textContent = '☀️ Tema Claro';
      }
    } catch (error) {
      console.error('Failed to load theme:', error);
      // Tema padrão (light)
      document.documentElement.removeAttribute('data-theme');
      this.elements.themeToggleBtn.textContent = '☀️ Tema Claro';
    }
  }

  private async loadFontSize() {
    try {
      const savedFontSize = localStorage.getItem(this.FONT_SIZE_KEY);
      const fontSize = savedFontSize ? parseFloat(savedFontSize) : 1;
      this.setFontSize(fontSize);
      this.elements.fontSizeSelect.value = fontSize.toString();
    } catch (error) {
      console.error('Failed to load font size:', error);
      // Tamanho padrão (médio)
      this.setFontSize(1);
      this.elements.fontSizeSelect.value = '1';
    }
  }

  private setFontSize(multiplier: number) {
    document.documentElement.style.setProperty('--font-size-multiplier', multiplier.toString());
    localStorage.setItem(this.FONT_SIZE_KEY, multiplier.toString());
  }

  private toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const isDark = currentTheme === 'dark';
    
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      this.elements.themeToggleBtn.textContent = '☀️ Tema Claro';
      localStorage.setItem(this.THEME_KEY, 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      this.elements.themeToggleBtn.textContent = '🌙 Tema Escuro';
      localStorage.setItem(this.THEME_KEY, 'dark');
    }
  }

  private handleReset(resetType: string) {
    if (resetType.startsWith('path-')) {
      // Resetar path params - formato: path-{method}-{pathId}
      const parts = resetType.split('-');
      const method = parts[1];
      const pathId = parts.slice(2).join('-'); // Junta o resto com hífen
      
      const pathInputs = document.querySelectorAll(`[data-path-param="${method}-${pathId}"]`);
      
      pathInputs.forEach(input => {
        const htmlInput = input as HTMLInputElement;
        const defaultValue = htmlInput.dataset.default || '';
        htmlInput.value = defaultValue;
      });
    } else if (resetType.startsWith('query-')) {
      // Resetar query params - formato: query-{method}-{pathId}
      const parts = resetType.split('-');
      const method = parts[1];
      const pathId = parts.slice(2).join('-'); // Junta o resto com hífen
      
      const queryInputs = document.querySelectorAll(`[data-query-param="${method}-${pathId}"]`);
      
      queryInputs.forEach(input => {
        const htmlInput = input as HTMLInputElement;
        const defaultValue = htmlInput.dataset.default || '';
        htmlInput.value = defaultValue;
      });
    } else if (resetType.startsWith('body-')) {
      // Resetar body - formato: body-{method}-{pathId}
      const parts = resetType.split('-');
      const method = parts[1];
      const pathId = parts.slice(2).join('-'); // Junta o resto com hífen
      
      const bodyTextarea = document.getElementById(`body-${method}-${pathId}`) as HTMLTextAreaElement;
      
      if (bodyTextarea) {
        const bodyKey = `${method}-${pathId}`;
        const defaultBody = this.defaultBodyValues.get(bodyKey) || '';
        bodyTextarea.value = defaultBody;
      }
    }
  }

  // Métodos para busca específica de resposta
  private clearResponseHighlights(container: HTMLElement, originalContent: string) {
    // Usar o conteúdo original salvo no dataset se disponível
    if (container.dataset.originalContent) {
      container.innerHTML = container.dataset.originalContent;
    } else {
      container.innerHTML = originalContent;
    }
  }

  private highlightResponseMatches(container: HTMLElement, searchTerm: string, currentIndex: number) {
    // Salvar o conteúdo original se ainda não foi salvo
    if (!container.dataset.originalContent) {
      container.dataset.originalContent = container.innerHTML;
    }
    
    // Restaurar conteúdo original antes de aplicar novos highlights
    container.innerHTML = container.dataset.originalContent;
    
    // Verificar se há conteúdo para buscar
    const textContent = container.textContent || '';
    if (!textContent) {
      return;
    }
    
    // Função para escapar caracteres especiais no searchTerm
    const escapeRegex = (str: string): string => {
      return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    };
    
    const escapedSearchTerm = escapeRegex(searchTerm);
    const searchRegex = new RegExp(escapedSearchTerm, 'gi');
    
    // Verificar se há matches
    if (!searchRegex.test(textContent)) {
      return;
    }
    
    // Resetar regex para uso
    searchRegex.lastIndex = 0;
    
    // Abordagem simples: usar mark.js style highlighting
    const highlightRegex2 = new RegExp(`(${escapedSearchTerm})`, 'gi');
    
    // Substituir apenas em nós de texto para evitar quebrar HTML
    // Esta é uma abordagem mais simples e robusta
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = container.innerHTML;
    
    const walker = document.createTreeWalker(
      tempDiv,
      NodeFilter.SHOW_TEXT,
      null
    );
    
    const textNodes: Text[] = [];
    let node;
    while (node = walker.nextNode()) {
      if (node.textContent && highlightRegex2.test(node.textContent)) {
        textNodes.push(node as Text);
      }
      highlightRegex2.lastIndex = 0;
    }
    
    textNodes.forEach(textNode => {
      const text = textNode.textContent || '';
      const highlightedText = text.replace(highlightRegex2, '<span class="response-highlight">$1</span>');
      
      if (highlightedText !== text) {
        const span = document.createElement('span');
        span.innerHTML = highlightedText;
        textNode.parentNode?.replaceChild(span, textNode);
      }
    });
    
    // Adicionar classe ao match atual
    const highlights = tempDiv.querySelectorAll('.response-highlight');
    highlights.forEach((highlight, index) => {
      if (index === currentIndex) {
        highlight.classList.add('current-response-match');
      }
    });
    
    // Atualizar o container com o conteúdo destacado
    container.innerHTML = tempDiv.innerHTML;
  }

  private scrollToResponseMatch(matchElement: HTMLElement) {
    matchElement.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
    
    // Remover highlight anterior e adicionar ao atual
    const container = matchElement.closest('.test-response-data');
    if (container) {
      container.querySelectorAll('.current-response-match').forEach(h => {
        h.classList.remove('current-response-match');
      });
      matchElement.classList.add('current-response-match');
    }
  }

  private addHeaderField(name: string = '', value: string = '') {
    const headerId = Date.now().toString();
    const headerElement = document.createElement('div');
    headerElement.className = 'header-item';
    headerElement.dataset.headerId = headerId;
    
    headerElement.innerHTML = `
      <div class="header-row">
        <input 
          type="text" 
          class="header-name" 
          placeholder="Nome do header" 
          value="${this.escapeHtml(name)}"
        />
        <input 
          type="text" 
          class="header-value" 
          placeholder="Valor (use 'uuid' para gerar automaticamente)" 
          value="${this.escapeHtml(value)}"
        />
        <button type="button" class="remove-header-btn" data-header-id="${headerId}">Remover</button>
      </div>
    `;
    
    this.elements.headersList.appendChild(headerElement);
    
    // Adicionar event listener para o botão de remover
    const removeBtn = headerElement.querySelector('.remove-header-btn') as HTMLButtonElement;
    removeBtn.addEventListener('click', () => {
      this.removeHeaderField(headerId);
    });
  }

  private removeHeaderField(headerId: string) {
    const headerElement = this.elements.headersList.querySelector(`[data-header-id="${headerId}"]`);
    if (headerElement) {
      headerElement.remove();
    }
  }

  private getHeadersFromForm(): Array<{ name: string; value: string }> {
    const headers: Array<{ name: string; value: string }> = [];
    
    this.elements.headersList.querySelectorAll('.header-item').forEach(item => {
      const nameInput = item.querySelector('.header-name') as HTMLInputElement;
      const valueInput = item.querySelector('.header-value') as HTMLInputElement;
      
      if (nameInput && valueInput && nameInput.value.trim()) {
        headers.push({
          name: nameInput.value.trim(),
          value: valueInput.value.trim()
        });
      }
    });
    
    return headers;
  }

  private clearHeaderFields() {
    this.elements.headersList.innerHTML = '';
  }

  private generateUUID(): string {
    // Implementação simples de UUID v4
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  private normalizeUrlToId(url: string): string {
    return url.trim()
      .replace(/\/$/, '')                    // Remove trailing slash
      .toLowerCase()                          // Normaliza case
      .replace(/^(https?):\/\//, '$1___')     // Transforma protocolo em https___ ou http___
      .replace(/\./g, '__')                   // Transforma . em __
      .replace(/[^\w\-\.:_]/g, '_')           // Substitui caracteres especiais, mantendo : e _
      .replace(/:/g, '___')                   // Transforma : em ___ (para portas)
      .replace(/_{2,}/g, '__')                // Normaliza múltiplos underscores
      .replace(/___+/g, '___');              // Normaliza múltiplos :___
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const configManager = new ConfigManager();
  configManager.init();
});
