const BaseService = require("../../services/BaseService");
const { TypeSpec } = require("../../services/drivers/meta/Construct");
const { TypedValue } = require("../../services/drivers/meta/Runtime");
const { Context } = require("../../util/context");

const MAX_FALLBACKS = 3 + 1; // includes first attempt

class AIChatService extends BaseService {
    static MODULES = {
        kv: globalThis.kv,
        uuidv4: require('uuid').v4,
    }

    _construct () {
        this.providers = [];

        this.simple_model_list = [];
        this.detail_model_list = [];
        this.detail_model_map = {};
    }
    _init () {
        this.kvkey = this.modules.uuidv4();

        const svc_event = this.services.get('event');
        svc_event.on('ai.prompt.report-usage', async (_, details) => {
            const user_id = details.actor?.type?.user?.id;
            const app_id = details.actor?.type?.app?.id;
            const service_name = details.service_used;
            const model_name = details.model_used;
            const value_uint_1 = details.usage?.input_tokens;
            const value_uint_2 = details.usage?.output_tokens;

            console.log('reporting usage', { user_id, app_id, service_name, model_name, value_uint_1, value_uint_2 });     });
    }

    async ['__on_boot.consolidation'] () {
        {
            const svc_driver = this.services.get('driver')
            for ( const provider of this.providers ) {
                svc_driver.register_service_alias('ai-chat',
                    provider.service_name);
            }
        }

        // TODO: get models and pricing for each model
        for ( const provider of this.providers ) {
            const delegate = this.services.get(provider.service_name)
                .as('puter-chat-completion');

            // Populate simple model list
            {
                const models = await (async () => {
                    try {
                        return await delegate.list() ?? [];
                    } catch (e) {
                        this.log.error(e);
                        return [];
                    }
                })();
                this.simple_model_list.push(...models);
            }

            // Populate detail model list and map
            {
                const models = await (async () => {
                    try {
                        return await delegate.models() ?? [];
                    } catch (e) {
                        this.log.error(e);
                        return [];
                    }
                })();
                const annotated_models = [];
                for ( const model of models ) {
                    annotated_models.push({
                        ...model,
                        provider: provider.service_name,
                    });
                }
                this.detail_model_list.push(...annotated_models);
                const set_or_push = (key, model) => {
                    // Typical case: no conflict
                    if ( ! this.detail_model_map[key] ) {
                        this.detail_model_map[key] = model;
                        return;
                    }

                    // Conflict: model name will map to an array
                    let array = this.detail_model_map[key];
                    if ( ! Array.isArray(array) ) {
                        array = [array];
                        this.detail_model_map[key] = array;
                    }

                    array.push(model);
                };
                for ( const model of annotated_models ) {
                    set_or_push(model.id, model);

                    if ( ! model.aliases ) continue;

                    for ( const alias of model.aliases ) {
                        set_or_push(alias, model);
                    }
                }
            }
        }
    }

    register_provider (spec) {
        this.providers.push(spec);
    }

    static IMPLEMENTS = {
        ['driver-capabilities']: {
            supports_test_mode (iface, method_name) {
                return iface === 'puter-chat-completion' &&
                    method_name === 'complete';
            }
        },
        ['puter-chat-completion']: {
            async models () {
                const delegate = this.get_delegate();
                if ( ! delegate ) return await this.models_();
                return await delegate.models();
            },
            async list () {
                const delegate = this.get_delegate();
                if ( ! delegate ) return await this.list_();
                return await delegate.list();
            },
            async complete (parameters) {
                const client_driver_call = Context.get('client_driver_call');
                let { test_mode, intended_service, response_metadata } = client_driver_call;
                
                this.log.noticeme('AIChatService.complete', { intended_service, parameters, test_mode });
                const svc_event = this.services.get('event');
                const event = {
                    allow: true,
                    intended_service,
                    parameters
                };
                if ( ! event.allow ) {
                    test_mode = true;
                }
                
                if ( ! test_mode && ! await this.moderate(parameters) ) {
                    test_mode = true;
                }

                if ( ! test_mode ) {
                    Context.set('moderated', true);
                }

                if ( test_mode ) {
                    intended_service = 'fake-chat';
                }

                if ( intended_service === this.service_name ) {
                    throw new Error('Calling ai-chat directly is not yet supported');
                }
                
                const svc_driver = this.services.get('driver');
                let ret, error, errors = [];
                let service_used = intended_service;
                let model_used = this.get_model_from_request(parameters);
                try {
                    ret = await svc_driver.call_new_({
                        actor: Context.get('actor'),
                        service_name: intended_service,
                        iface: 'puter-chat-completion',
                        method: 'complete',
                        args: parameters,
                    });
                } catch (e) {
                    const tried = [];
                    let model = model_used;

                    // TODO: if conflict models exist, add service name
                    tried.push(model);

                    error = e;
                    errors.push(e);
                    console.error(e);
                    this.log.error('error calling service', {
                        intended_service,
                        model,
                        error: e,
                    });
                    while ( !! error ) {
                        const fallback = this.get_fallback_model({
                            model, tried,
                        });

                        if ( ! fallback ) {
                            throw new Error('no fallback model available');
                        }

                        const {
                            fallback_service_name,
                            fallback_model_name,
                        } = fallback;

                        this.log.warn('model fallback', {
                            intended_service,
                            fallback_service_name,
                            fallback_model_name
                        });

                        try {
                            ret = await svc_driver.call_new_({
                                actor: Context.get('actor'),
                                service_name: fallback_service_name,
                                iface: 'puter-chat-completion',
                                method: 'complete',
                                args: {
                                    ...parameters,
                                    model: fallback_model_name,
                                },
                            });
                            error = null;
                            service_used = fallback_service_name;
                            model_used = fallback_model_name;
                            response_metadata.fallback = {
                                service: fallback_service_name,
                                model: fallback_model_name,
                                tried: tried,
                            };
                        } catch (e) {
                            error = e;
                            errors.push(e);
                            tried.push(fallback_model_name);
                            this.log.error('error calling fallback', {
                                intended_service,
                                model,
                                error: e,
                            });
                        }
                    }
                }
                ret.result.via_ai_chat_service = true;
                response_metadata.service_used = service_used;

                const username = Context.get('actor').type?.user?.username;

                if (
                    // Check if we have 'ai-chat-intermediate' response type;
                    // this means we're streaming and usage comes from a promise.
                    (ret.result instanceof TypedValue) &&
                    TypeSpec.adapt({ $: 'ai-chat-intermediate' })
                    .equals(ret.result.type)
                ) {
                    (async () => {
                        const usage_promise = ret.result.value.usage_promise;
                        const usage = await usage_promise;
                        await svc_event.emit('ai.prompt.report-usage', {
                            actor: Context.get('actor'),
                            service_used,
                            model_used,
                            usage,
                        });
                    })();
                    return ret.result.value.response;
                } else {
                    await svc_event.emit('ai.prompt.report-usage', {
                        actor: Context.get('actor'),
                        username,
                        service_used,
                        model_used,
                        usage: ret.result.usage,
                    });
                }
                
                console.log('emitting ai.prompt.complete');
                await svc_event.emit('ai.prompt.complete', {
                    username,
                    intended_service,
                    parameters,
                    result: ret.result,
                    model_used,
                    service_used,
                });

                return ret.result;
            }
        }
    }
    
    async moderate ({ messages }) {
        const svc_openai = this.services.get('openai-completion');

        // We can't use moderation of openai service isn't available
        if ( ! svc_openai ) return true;
        
        for ( const msg of messages ) {
            const texts = [];
            if ( typeof msg.content === 'string' ) texts.push(msg.content);
            else if ( typeof msg.content === 'object' ) {
                if ( Array.isArray(msg.content) ) {
                    texts.push(...msg.content.filter(o => (
                        ( ! o.type && o.hasOwnProperty('text') ) ||
                        o.type === 'text')).map(o => o.text));
                }
                else texts.push(msg.content.text);
            }
            
            const fulltext = texts.join('\n');
            
            const mod_result = await svc_openai.check_moderation(fulltext);
            if ( mod_result.flagged ) return false;
        }
        return true;
    }

    async models_ () {
        return this.detail_model_list;
    }

    async list_ () {
        return this.simple_model_list;
    }

    get_delegate () {
        const client_driver_call = Context.get('client_driver_call');
        if ( client_driver_call.intended_service === this.service_name ) {
            return undefined;
        }
        console.log('getting service', client_driver_call.intended_service);
        const service = this.services.get(client_driver_call.intended_service);
        return service.as('puter-chat-completion');
    }

    /**
     * Find an appropriate fallback model by sorting the list of models
     * by the euclidean distance of the input/output prices and selecting
     * the first one that is not in the tried list.
     * 
     * @param {*} param0 
     * @returns 
     */
    get_fallback_model ({ model, tried }) {
        let target_model = this.detail_model_map[model];
        if ( ! target_model ) {
            this.log.error('could not find model', { model });
            throw new Error('could not find model');
        }
        if ( Array.isArray(target_model) ) {
            // TODO: better conflict resolution
            this.log.noticeme('conflict exists', { model, target_model });
            target_model = target_model[0];
        }

        // First check KV for the sorted list
        let sorted_models = this.modules.kv.get(
            `${this.kvkey}:fallbacks:${model}`);

        if ( ! sorted_models ) {
            // Calculate the sorted list
            const models = this.detail_model_list;

            sorted_models = models.sort((a, b) => {
                return Math.sqrt(
                    Math.pow(a.cost.input - target_model.cost.input, 2) +
                    Math.pow(a.cost.output - target_model.cost.output, 2)
                ) - Math.sqrt(
                    Math.pow(b.cost.input - target_model.cost.input, 2) +
                    Math.pow(b.cost.output - target_model.cost.output, 2)
                );
            });

            sorted_models = sorted_models.slice(0, MAX_FALLBACKS);

            this.modules.kv.set(
                `${this.kvkey}:fallbacks:${model}`, sorted_models);
        }

        for ( const model of sorted_models ) {
            if ( tried.includes(model.id) ) continue;

            return {
                fallback_service_name: model.provider,
                fallback_model_name: model.id,
            };
        }

        // No fallbacks available
        this.log.error('no fallbacks', {
            sorted_models,
            tried,
        });
    }

    get_model_from_request (parameters) {
        const client_driver_call = Context.get('client_driver_call');
        let { intended_service } = client_driver_call;

        let model = parameters.model;
        if ( ! model ) {
            const service = this.services.get(intended_service);
            if ( ! service.get_default_model ) {
                throw new Error('could not infer model from service');
            }
            model = service.get_default_model();
            if ( ! model ) {
                throw new Error('could not infer model from service');
            }
        }

        return model;
    }
}

module.exports = { AIChatService };
