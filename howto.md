# HOWTO

1) Docker Container starten über docker-compose.yml
* Bitbucket
* Bamboo
* Jira
* LLM-Proxy (für die KI Anbindung)

2) In Bitbucket
* Repository erstellen
* Bitbucket mit bamboo verlinken (Incoming/Outgoing Application links OAuth nicht OAuth2)
* Remote bamboo agent hinzufügen, approve access im bamboo server

3) In Bamboo: 
* Bamboo mit bitbucket verlinken (Incoming/Outgoing Application links OAuth nicht OAuth2)
* Buildplan erstellen
* Script Task hinzufügen: llm-script-task.py
* Linked Repository einrichten
* JIRA Token einrichten (Plan Variable)
* BitBucket Token einrichten  (Plan Variable)
* Enable Buildplan

4) In Jira:
* Projekt erstellen
* Ticket erstellen
* Bamboo mit Jira verlinken (Application links OAuth nicht OAuth2)

5) In LLM-Proxy: 
* API Key für OpenAI hinterlegen -> .env Datei anlegen mit  OPENAI_API_KEY=<key>
* Optional LLM festlegen in .env (z.B. OPENAI_MODEL=gpt-4)




