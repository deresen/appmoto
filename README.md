# Passo

Una prima versione, in italiano e pensata per smartphone, per condividere le condizioni delle strade. La mappa raccoglie segnalazioni geolocalizzate di **buche, ghiaia, olio, ostacoli e chiusure**. Gli altri utenti possono confermare che una segnalazione è ancora presente; inserimenti e conferme si aggiornano nelle altre sessioni tramite Server-Sent Events (SSE).

I punti contrassegnati come **ESEMPIO** servono a esplorare l'interfaccia: non descrivono condizioni stradali verificate. Nel database la loro origine è `demo`. Passo è un prototipo, non un servizio di emergenza o uno strumento di navigazione.

## Avvio locale

Sono necessari **Node.js 24 o successivo** e npm. Il backend usa SQLite integrato in Node.js: non occorre installare un database separato.

```bash
cd /workspace/appmoto
npm ci
npm run dev
```

Se, in questo ambiente cloud, la cache npm predefinita non è scrivibile, usa `npm ci --cache /tmp/passo-npm-cache` al posto di `npm ci`. Non occorre modificare il lockfile o disattivare verifiche di integrità.

Il server Vite è sulla porta `5173` e inoltra le richieste `/api` al backend sulla porta `3001`. Per accedere da un altro dispositivo, usa un indirizzo raggiungibile del computer che esegue il progetto. La geolocalizzazione del browser richiede HTTPS, salvo l'eccezione locale prevista dai browser.

Per creare ed eseguire la build:

```bash
npm run build
npm start
```

In questa modalità il backend serve anche l'interfaccia compilata dalla cartella `dist`, sulla porta `3001` predefinita. La porta è scelta da `PORT` se presente, altrimenti da `API_PORT`; `PORT` è usata dagli hosting come Render.

## Pubblicazione su Render

È predisposto [`render.yaml`](render.yaml) per un singolo server Node.js in Europa e un disco persistente da 1 GB. **Il servizio Starter e il disco sono a pagamento**: controlla il prezzo mostrato da Render prima di applicare la configurazione. Creare l'account non pubblica l'app e non attiva da solo queste risorse.

1. Crea un account su [Render](https://dashboard.render.com/register) usando GitHub.
2. Salva il codice del progetto nel repository `deresen/appmoto`, sul branch `main`. Il codice presente soltanto nel workspace cloud non è ancora disponibile a Render. Prima di eseguire un push verifica le modifiche e l'autorizzazione a inviarle al repository; non includere `.env`, database o credenziali.
3. Nella dashboard Render crea una **Blueprint** dal repository. Il file configura il comando di build, l'avvio, HTTPS tramite Render e il volume in `/var/data`. Rivedi servizio, disco e costi, poi conferma la creazione.
4. Quando Render indica che il servizio è attivo, apri l'indirizzo HTTPS assegnato dal servizio dal telefono. Verifica mappa e inserimento, poi apri una seconda sessione per controllare le conferme in tempo reale. Un risultato positivo in locale non dimostra che questa distribuzione sia già riuscita.

La build installa le dipendenze di sviluppo per TypeScript/Vite e poi le rimuove. `tsx` rimane fra le dipendenze di produzione perché `npm start` lo usa per eseguire il backend. In produzione i cookie tecnici usano `Secure`; `TRUST_PROXY=1` abilita la fiducia in un solo proxy davanti al server. Attivala soltanto su un hosting con ingress controllato: non è adatta a un server direttamente esposto a richieste con intestazioni inoltrate arbitrarie. Non vengono accettati siti esterni tramite CORS.

Il disco mantiene segnalazioni, conferme e identità del browser fra riavvii. Non aggiungere repliche: SQLite e SSE sono configurati per un solo processo. La configurazione pubblica usa `SEED_DEMO=0`, quindi un database nuovo parte senza segnalazioni dimostrative. Le pubblicazioni automatiche sono disattivate: i successivi aggiornamenti si avviano dalla dashboard Render.

## Verifiche

```bash
npm run typecheck
npm test
npm run build
```

La suite del backend usa un database isolato. Per verificare il flusso completo, apri due sessioni con cookie separati, per esempio una finestra normale e una privata. Inserisci una segnalazione dalla prima e verifica che compaia nella seconda senza ricaricare. Confermala dalla seconda sessione e verifica l'aggiornamento del conteggio nella prima. Un browser non può confermare ripetutamente la stessa segnalazione.

## Dati e aggiornamenti in tempo reale

- I dati sono salvati in `data/appmoto.sqlite`. La variabile `DATA_DIR` permette di scegliere una cartella diversa; `PORT` o, in sua assenza, `API_PORT` modifica la porta del backend.
- Conserva la cartella dati su un volume persistente durante la distribuzione. Cancellarla elimina anche segnalazioni e conferme.
- Ogni browser riceve un identificatore anonimo in un cookie HttpOnly. Serve a evitare conferme duplicate nello stesso browser; non equivale a un account verificato e non impedisce abusi da browser diversi.
- SSE mantiene sincronizzate le sessioni collegate allo stesso server. Il proxy di distribuzione deve consentire connessioni HTTP persistenti e non accumulare il flusso SSE in un buffer.
- Ogni segnalazione scade **24 ore dopo la creazione**. Le conferme non ne prolungano la durata. Le informazioni non devono essere considerate certe o permanenti e la conferma della community non sostituisce una verifica sul posto.
- L'API e il flusso SSE restituiscono al massimo le **500 segnalazioni attive più recenti**. Ricerca e filtri operano su queste segnalazioni caricate; la ricerca non cerca indirizzi esterni o località prive di segnalazioni. Non sono ancora disponibili paginazione o ricerca geografica sul server.
- Al primo avvio vengono aggiunte alcune segnalazioni di esempio. Per impedirlo su un database non ancora inizializzato, avvia con `SEED_DEMO=0 npm run dev` oppure `SEED_DEMO=0 npm start`. Anche `SEED_DEMO=false` disabilita l'inserimento. La variabile non elimina esempi già salvati e non li aggiorna: gli esempi vengono inseriti una sola volta per database e scadono come le altre segnalazioni.

## Servizi esterni necessari

| Servizio          | Uso nella prima versione                       | Requisiti                                                                                             |
| ----------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| OpenStreetMap     | Immagini della mappa richieste dal browser     | Connessione Internet HTTPS a `tile.openstreetmap.org`; attribuzione visibile a OpenStreetMap.         |
| Un server Node.js | API, aggiornamenti SSE e interfaccia compilata | Node.js 24+, HTTPS, volume persistente per SQLite. Può essere il computer locale durante lo sviluppo. |

Non sono necessari account o chiavi di un servizio realtime: gli aggiornamenti passano dal backend dell'app. Non sono integrati servizi di navigazione, calcolo dei percorsi o geocodifica esterna.

Nell'istanza cloud usata per lo sviluppo, `tile.openstreetmap.org` è stato aggiunto ai domini consentiti e l'accesso al servizio è stato verificato ricevendo una vera immagine cartografica. La verifica delle immagini nel browser automatico resta incompleta: quel browser non riconosce il certificato del proxy della macchina. Non sono state disattivate verifiche TLS né modificati i certificati di fiducia globali. Questo limite riguarda il browser automatico di questa macchina; la visualizzazione dovrà essere verificata anche sul dominio HTTPS effettivamente pubblicato. Su una distribuzione ordinaria è necessaria la connettività Internet del browser verso il dominio delle immagini.

Le tile pubbliche OpenStreetMap sono adatte a un uso contenuto e soggette alla [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/): mantieni l'attribuzione, rispetta le intestazioni di cache e non scaricare mappe in massa o per l'uso offline. Per un lancio pubblico e traffico significativo, scegli un fornitore di mappe con un piano adeguato, per esempio MapTiler, e configura il relativo URL e l'eventuale chiave. Il piano, la chiave e i domini consentiti dipendono dal fornitore scelto.

## Privacy e limiti prima del lancio pubblico

La posizione viene richiesta solo su azione dell'utente; non è previsto un tracciamento continuo. La posizione scelta e il testo inviati con una segnalazione vengono salvati e mostrati agli altri utenti. Evita nomi, targhe e altri dati personali nel testo libero.

Questa versione è progettata per un singolo processo server. Prima di aprirla al pubblico servono una valutazione delle misure antiabuso, moderazione, autenticazione adeguata al prodotto, backup e una politica di conservazione dei dati. Per più istanze occorrono un database condiviso e un canale pub/sub per distribuire gli eventi fra server. Le identità anonime del prototipo non garantiscono l'attendibilità delle segnalazioni.

Il manifest permette l'apertura in modalità standalone sui dispositivi compatibili. Non è inclusa una modalità offline e i dati della mappa richiedono la rete.
