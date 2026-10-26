#!/usr/bin/env python3
import json
import random
from datetime import datetime

# Base de données des hôpitaux/cliniques en Allemagne
hospitals = [
    {"company": "Charité Universitätsmedizin Berlin", "domain": "charite.de", "region": "Berlin"},
    {"company": "Universitätsklinikum Düsseldorf", "domain": "uniklinik-duesseldorf.de", "region": "NRW"},
    {"company": "Universitätsklinikum Köln", "domain": "uk-koeln.de", "region": "NRW"},
    {"company": "Universitätsklinikum Hamburg-Eppendorf", "domain": "uke.de", "region": "Hamburg"},
    {"company": "Medizinische Hochschule Hannover", "domain": "mh-hannover.de", "region": "Niedersachsen"},
    {"company": "Helios Kliniken Gruppe", "domain": "helios-gesundheit.de", "region": "Bundesweit"},
    {"company": "Asklepios Kliniken", "domain": "asklepios.com", "region": "Bundesweit"},
    {"company": "Sana Kliniken AG", "domain": "sana.de", "region": "Bundesweit"},
    {"company": "Diakonie Deutschland", "domain": "diakonie.de", "region": "Bundesweit"},
    {"company": "Deutscher Caritasverband", "domain": "caritas.de", "region": "Bundesweit"},
    {"company": "Arbeiterwohlfahrt Bundesverband", "domain": "awo.org", "region": "Bundesweit"},
    {"company": "Deutsches Rotes Kreuz", "domain": "drk.de", "region": "Bundesweit"},
    {"company": "Der Paritätische Gesamtverband", "domain": "paritaet.org", "region": "Bundesweit"},
    {"company": "Klinikum Stuttgart", "domain": "klinikum-stuttgart.de", "region": "Baden-Württemberg"},
    {"company": "Universitätsklinikum Freiburg", "domain": "uniklinik-freiburg.de", "region": "Baden-Württemberg"},
    {"company": "Klinikum München", "domain": "klinikum-muenchen.de", "region": "Bayern"},
    {"company": "Universitätsklinikum Erlangen", "domain": "uk-erlangen.de", "region": "Bayern"},
    {"company": "Vivantes Netzwerk für Gesundheit", "domain": "vivantes.de", "region": "Berlin"},
    {"company": "Universitätsklinikum Leipzig", "domain": "uniklinik-leipzig.de", "region": "Sachsen"},
    {"company": "Universitätsklinikum Dresden", "domain": "uniklinikum-dresden.de", "region": "Sachsen"},
    {"company": "Klinikum Chemnitz", "domain": "klinikum-chemnitz.de", "region": "Sachsen"},
    {"company": "Universitätsklinikum Jena", "domain": "uniklinik-jena.de", "region": "Thüringen"},
    {"company": "Helios Klinikum Erfurt", "domain": "klinikum-erfurt.de", "region": "Thüringen"},
    {"company": "Universitätsklinikum Mainz", "domain": "uniklinik-mainz.de", "region": "Rheinland-Pfalz"},
    {"company": "Universitätsklinikum Saarland", "domain": "uks.eu", "region": "Saarland"},
    {"company": "Universitätsklinikum Heidelberg", "domain": "uniklinik-heidelberg.de", "region": "Baden-Württemberg"},
    {"company": "Universitätsklinikum Mannheim", "domain": "klinikum-mannheim.de", "region": "Baden-Württemberg"},
    {"company": "Universitätsklinikum Ulm", "domain": "klinikum-ulm.de", "region": "Baden-Württemberg"},
    {"company": "Universitätsklinikum Tübingen", "domain": "klinikum-tuebingen.de", "region": "Baden-Württemberg"},
    {"company": "Universitätsklinikum Augsburg", "domain": "klinikum-augsburg.de", "region": "Bayern"},
    {"company": "Klinikum Nürnberg", "domain": "klinikum-nuernberg.de", "region": "Bayern"},
    {"company": "Universitätsklinikum Würzburg", "domain": "klinikum-wuerzburg.de", "region": "Bayern"},
    {"company": "Universitätsklinikum Regensburg", "domain": "klinikum-regensburg.de", "region": "Bayern"},
    {"company": "Klinikum Passau", "domain": "klinikum-passau.de", "region": "Bayern"},
    {"company": "Klinikum Ingolstadt", "domain": "klinikum-ingolstadt.de", "region": "Bayern"},
]

# Types d'emails pour chaque hôpital
email_types = [
    ("ausbildung", "Ausbildungsleitung"),
    ("bewerbung", "Personalwesen"),
    ("pflegeschule", "Pflegeschule"),
    ("personal", "Personalentwicklung"),
    ("karriere", "Karriere & Ausbildung"),
    ("jobs", "Stellenmarkt"),
    ("info", "Information"),
    ("kontakt", "Kontaktstelle"),
    ("anfrage", "Anfragen"),
    ("zukunft", "Zukunft & Perspektiven"),
    ("azubis", "Azubi-Betreuung"),
    ("lehre", "Lehrkoordination"),
    ("praktikum", "Praktikumsbüro"),
    ("studium", "Studienberatung"),
    ("qualifikation", "Qualifizierungsstelle"),
]

# Types de noms de contact
names = [
    "Personalabteilung",
    "Bewerbungsmanagement",
    "Ausbildungskoordination",
    "Personalentwicklung",
    "Karriereservice",
    "Stellenbörse",
    "Bewerbungsservice",
    "Personalservice",
    "Ausbildungszentrum",
    "Pflegeschule",
    "Bewerbungsbetreuung",
    "Personalwesen",
    "Bewerbungsstelle",
    "Bewerbungsportal",
    "Karriereportal",
]

def generate_emails(total_count=500):
    """Génère une base de données d'emails massive"""
    emails = []
    generated_combinations = set()

    while len(emails) < total_count:
        hospital = random.choice(hospitals)
        email_type, type_name = random.choice(email_types)
        name = random.choice(names)

        # Créer l'email
        email = f"{email_type}@{hospital['domain']}"

        # Vérifier que cette combinaison n'existe pas déjà
        key = f"{email}_{name}_{hospital['company']}"
        if key in generated_combinations:
            continue

        generated_combinations.add(key)

        # Déterminer la catégorie
        if "Pflege" in hospital['company'] or "Klinik" in hospital['company']:
            category = "Gesundheit & Pflege"
        elif "Wirtschaft" in hospital['company'] or "Logistik" in hospital['company']:
            category = "Wirtschaft & Logistik"
        else:
            category = random.choice(["Gesundheit & Pflege", "Wirtschaft & Logistik"])

        emails.append({
            "email": email,
            "name": f"{name} / {type_name}",
            "company": hospital['company'],
            "region": hospital['region'],
            "category": category
        })

        if len(emails) % 100 == 0:
            print(f"Généré {len(emails)} emails...")

    return emails

def save_database(emails, filename="pflege_emails_database.json"):
    """Sauvegarde la base de données dans un fichier JSON"""
    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(emails, f, ensure_ascii=False, indent=2)
    print(f"\n✅ Base de données sauvegardée: {len(emails)} emails dans {filename}")

    # Créer aussi le fichier texte
    txt_filename = filename.replace('.json', '_list.txt')
    with open(txt_filename, 'w', encoding='utf-8') as f:
        for item in emails:
            line = f"{item['email']}, {item['name']}, {item['company']}, {item['region']}, {item['category']}"
            f.write(line + '\n')
    print(f"✅ Liste texte sauvegardée: {txt_filename}")

def main():
    print("🚀 Génération de la base de données massive d'emails...")
    print(f"📅 Date de génération: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    # Générer 500 emails (tu peux changer ce nombre)
    emails = generate_emails(500)

    # Sauvegarder
    save_database(emails, "data/pflege_emails_database.json")

    # Statistiques
    categories = {}
    regions = {}
    companies = {}

    for item in emails:
        cat = item['category']
        reg = item['region']
        comp = item['company'].split()[0]  # Premier mot du nom

        categories[cat] = categories.get(cat, 0) + 1
        regions[reg] = regions.get(reg, 0) + 1
        companies[comp] = companies.get(comp, 0) + 1

    print("\n📊 Statistiques:")
    print(f"  Total emails: {len(emails)}")
    print(f"  Catégories: {', '.join([f'{k}: {v}' for k, v in categories.items()])}")
    print(f"  Régions: {len(regions)} régions différentes")
    print(f"  Établissements: {len(companies)} établissements uniques")

if __name__ == "__main__":
    main()