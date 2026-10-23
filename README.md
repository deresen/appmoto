# Passo

Una prima versione in italiano, pensata per smartphone, con dieci tipi di segnalazione: **buche, strada dissestata, ghiaia, terra, fango, olio, ostacoli, chiusure, autovelox mobile e altro pericolo**. Si può confermare se sono ancora presenti e indicare quando sono risolti. Inserimenti, voti e rimozioni si aggiornano nelle altre sessioni senza ricaricare la pagina. Per **Altro pericolo**, la descrizione deve contenere almeno dieci caratteri, esclusi gli spazi iniziali e finali.

La pubblicazione prevista usa **Cloudflare Workers Free**, risorse statiche e un **Durable Object con SQLite persistente**. Non richiede un server Node a pagamento o un disco effimero. Il percorso usa il sottodominio gratuito `workers.dev`: non occorre comprare un dominio. Un account Render eventualmente creato non serve e non è necessario attivarvi servizi o dischi.

## Segnalazioni presenti, risolte e possibili duplicati

- **Confermo, è presente** conferma il pericolo; **Non è più presente** aggiunge un voto alla sua risoluzione. Ogni browser può avere un solo voto per segnalazione: scegliere l'altra azione sostituisce il proprio voto precedente. Ripetere la stessa azione non aumenta il conteggio.
- Con **tre voti di risoluzione di browser distinti**, la segnalazione viene rimossa dalla mappa e dagli aggiornamenti di tutti. La risoluzione è definitiva per quella segnalazione: un nuovo pericolo richiede un nuovo inserimento. I browser non equivalgono a persone verificate; cancellare i cookie o usare altri browser può aggirare questo riconoscimento.
- Prima di inserire una segnalazione, il server cerca altre segnalazioni community attive dello **stesso tipo entro 75 metri**. In caso di possibile duplicato restituisce fino alle tre più vicine senza inserire nuovi dati. Si può confermare quella esistente oppure proseguire esplicitamente se si tratta di un pericolo distinto. Gli esempi dimostrativi, le segnalazioni scadute e quelle risolte non bloccano l'inserimento.

Nessuno dei voti prolunga la scadenza: gli **autovelox mobili durano un'ora dalla creazione**, tutte le altre categorie **24 ore**. La migrazione delle categorie conserva segnalazioni, conferme, voti di risoluzione, stati già risolti e sessioni esistenti.

## Segnalazioni vicino a me

La ricerca nelle vicinanze usa la posizione richiesta al browser su azione dell'utente. Il raggio iniziale è di **10 km**, con scelta fra **5, 10 o 25 km**. Le segnalazioni sono inizialmente ordinate per distanza; si può cambiare l'ordinamento. Le coordinate usate per questo filtro restano nel browser, senza essere inviate al backend. Non è incluso un tracciamento continuo: per cambiare punto di riferimento occorre richiedere di nuovo la posizione.

Il filtro e le distanze sono calcolati sui dati già ricevuti, al massimo le **500 segnalazioni attive più recenti**. Non garantiscono una ricerca completa di tutte le strade nella zona. Se il permesso di posizione viene negato o il GPS non è disponibile, la mappa e i filtri normali restano utilizzabili. La geolocalizzazione richiede un browser compatibile e HTTPS, salvo localhost per lo sviluppo; non aggiunge servizi o abbonamenti a pagamento.

## Sviluppo locale

Servono **Node.js 24+** e npm:

```bash
cd /workspace/appmoto
npm ci
npm run dev
```

Vite usa la porta `5173`, con proxy `/api` verso Node sulla `3001`. Questo percorso locale usa SQLite in `data/appmoto.sqlite` e aggiornamenti SSE. Al primo avvio del database aggiunge sei segnalazioni **ESEMPIO**; non sono condizioni stradali reali. `SEED_DEMO=0` o `false` impedisce l'inserimento iniziale, senza eliminare o rinnovare gli esempi già salvati. `DATA_DIR` cambia la cartella dati; `PORT`, se presente, precede `API_PORT`. `.env.example` descrive le variabili: il server Node non carica automaticamente `.env`.

Se la cache npm predefinita non è scrivibile nell'ambiente cloud, usa `npm ci --cache /tmp/passo-npm-cache`.

Per provare lo stesso runtime previsto per la pubblicazione:

```bash
npm run dev:cloud
```

Wrangler esegue la build configurata e avvia l'app sulla porta `8787`, con API, risorse statiche, SQLite del Durable Object e WebSocket Hibernation. Lo stato di sviluppo è locale: non è il database online e non viene trasferito automaticamente alla pubblicazione. Questo percorso parte senza dati dimostrativi.

`npm run build && npm start` resta disponibile per eseguire la build con il backend Node locale sulla porta `3001`; non è il comando di distribuzione su Cloudflare.

## Pubblicazione gratuita

Una versione precedente è stata pubblicata su **https://appmoto.angellotti-gius.workers.dev** e l'utente ne ha confermato il funzionamento. Le nuove modifiche richiedono una nuova distribuzione prima di essere disponibili online. Per pubblicare occorre creare o usare il proprio account e mantenere il piano **Workers Free**, senza attivare Workers Paid o altri prodotti a pagamento.

1. Salva il codice nel repository GitHub `deresen/appmoto`. Il codice presente soltanto nel workspace non è disponibile alla piattaforma di pubblicazione; escludi database, `.env` e credenziali.
2. Nel [dashboard Cloudflare](https://dash.cloudflare.com/) apri **Workers & Pages → Create application → GitHub**, autorizza il collegamento e scegli il repository.
3. Il Worker esistente si chiama **`appmoto`**, come `name` in `wrangler.jsonc`; **Passo** resta il nome dell'app. Usa `npm run deploy` come comando di distribuzione: Wrangler esegue la build personalizzata configurata. Workers Builds gestisce l'autenticazione nel dashboard; non occorre incollare un token in chat.
4. Apri l'URL HTTPS `workers.dev` assegnato. Verifica la mappa, pubblica una segnalazione e confermala da una seconda sessione con cookie separati. Controlla gli aggiornamenti senza ricaricare e la permanenza del dato dopo una nuova visita o distribuzione.

In alternativa, dalla propria macchina si può eseguire `npx wrangler login` e poi `npm run deploy`. Il login avviene nel browser con il proprio account. Non serve un servizio realtime separato né una sua chiave API.

### Quote del piano Free

Le quote verificate nella documentazione ufficiale sono condivise a livello di account. Restando sul piano Free non ci sono costi di abbonamento per queste risorse: **al superamento di una quota gratuita le relative operazioni si fermano con un errore**, anziché essere fatturate come consumo aggiuntivo. I limiti giornalieri si ripristinano alle `00:00 UTC`. Non è un servizio illimitato e le condizioni del fornitore possono cambiare.

| Risorsa                                           | Quota Free documentata                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| Worker dinamico                                   | 100.000 richieste/giorno, 10 ms di CPU per invocazione                     |
| Risorse statiche servite senza invocare il Worker | Richieste gratuite e illimitate; nessun costo aggiuntivo di archiviazione  |
| Durable Objects                                   | 100.000 richieste/giorno e 13.000 GB-s/giorno di durata attiva             |
| SQLite dei Durable Objects                        | 5 milioni di righe lette/giorno, 100.000 righe scritte/giorno, 5 GB totali |
| Workers Builds                                    | 3.000 minuti/mese, una build contemporanea, timeout di 20 minuti           |

Il realtime usa l'API **WebSocket Hibernation** per consentire all'oggetto di dormire quando inattivo lasciando collegati i client. Le richieste e l'attività continuano comunque a consumare le quote previste. Questa configurazione non attiva un passaggio automatico a un piano a pagamento.

Fonti: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Static Assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [Builds limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/), [Git integration e pubblicazione](https://developers.cloudflare.com/workers/ci-cd/builds/), [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

## Verifiche

```bash
npm run typecheck
npm test
npm run build
```

La suite include controlli isolati del backend Node e del Worker nel runtime locale: dieci categorie, durata degli autovelox mobili, validazione delle segnalazioni generiche, voti esclusivi e idempotenti, risoluzione definitiva, rimozione in SSE/WebSocket, duplicati e migrazione da database precedenti con vincoli SQLite e riavvio. I test Cloudflare usano soltanto workerd locale e non pubblicano risorse sull'account. Un test locale riuscito non dimostra che la distribuzione online sia avvenuta. L'endpoint `/api/health` permette di distinguere il backend locale SQLite/SSE dal Worker SQLite/WebSocket.

Per il controllo funzionale usa due sessioni con cookie separati, per esempio una finestra normale e una privata: crea una segnalazione nella prima, verifica che compaia nella seconda, confermala dalla seconda e verifica l'aggiornamento nella prima. Controlla anche che una seconda conferma dallo stesso browser non aumenti il conteggio.

Prova poi **Non è più presente**: la conferma dello stesso browser deve essere sostituita. Con tre sessioni distinte, il terzo voto di risoluzione deve rimuovere il punto da tutte le mappe. Per provare i duplicati, tenta un inserimento dello stesso tipo vicino a un punto community attivo: deve comparire l'alternativa di usare quello esistente, senza aggiungere una nuova segnalazione salvo scelta esplicita del pericolo distinto.

## Dati e privacy

- In Cloudflare, segnalazioni, conferme e voti Risolto risiedono nello SQLite persistente di un singolo Durable Object globale; non dipendono dal filesystem temporaneo del Worker. La pubblicazione parte senza esempi.
- Gli **autovelox mobili restano visibili per un'ora dalla creazione**, le altre categorie per **24 ore**, oppure fino alla risoluzione se precedente. I voti non ne prolungano la durata. Il Worker conserva i record fino alla pulizia prevista dopo ulteriori 24 ore dalla scadenza. L'API restituisce al massimo le **500 segnalazioni attive più recenti**: ricerca, vicinanze e filtri operano sui dati caricati, non su un geocodificatore esterno. Il controllo dei duplicati considera anche le segnalazioni attive fuori da questo limite.
- Un cookie tecnico anonimo HttpOnly, e Secure su HTTPS, riconosce i voti dello stesso browser. Non equivale a un account e non impedisce abusi da browser differenti. App e API usano la stessa origine.
- La posizione viene richiesta soltanto su azione dell'utente, senza tracciamento continuo. Quando si pubblica vengono condivisi il punto scelto, la categoria e il testo: non inserire dati personali.
- Prima di un lancio pubblico più ampio servono moderazione, misure antiabuso adeguate, backup e una politica di conservazione e cancellazione dei dati. La scadenza della visibilità non va confusa con una politica completa di cancellazione.

## Mappa e limiti del prototipo

Le immagini della mappa arrivano dal servizio pubblico **OpenStreetMap** su `https://tile.openstreetmap.org`, senza chiave API. Il browser deve poter raggiungere il dominio e l'attribuzione deve rimanere visibile. Il servizio è best effort: rispetta la [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/), la cache e il divieto di scaricamento in massa o per uso offline. Non è una garanzia di capacità gratuita illimitata per un'app in crescita.

Nell'ambiente cloud di sviluppo è stata verificata una vera immagine cartografica via HTTPS. La verifica delle immagini nel browser automatico resta limitata dal certificato del proxy di quella macchina; non sono state disattivate le verifiche TLS. La mappa va verificata anche sul dominio pubblicato.

Il manifest permette la modalità standalone sui dispositivi compatibili; non è inclusa una modalità offline. Le informazioni della community non sono verificate: Passo non sostituisce la segnaletica, la navigazione o i servizi di emergenza. Segnala solo dopo esserti fermato.
