import json,datetime,pathlib
from PIL import Image,ImageDraw,ImageFont
BASE=pathlib.Path(__file__).parent
RAW="Bonjour|Hello;Merci|Thank you;Bonsoir|Good evening;Bonne nuit|Good night;De rien|You're welcome;S'il vous plaît|Please;Excusez-moi|Excuse me;À bientôt|See you soon;À demain|See you tomorrow;Bienvenue|Welcome\nJe m'appelle|My name is;Enchanté|Nice to meet you;Comment ça va ?|How are you?;Je vais bien|I'm fine;Je suis étudiant|I'm a student;J'habite ici|I live here;Je viens du Maroc|I'm from Morocco;Quel âge as-tu ?|How old are you?;J'ai vingt ans|I'm twenty;Je parle anglais|I speak English\nÊtre|To be;Avoir|To have;Aller|To go;Faire|To do;Parler|To speak;Manger|To eat;Boire|To drink;Apprendre|To learn;Écrire|To write;Lire|To read\nMaison|House;Chambre|Bedroom;Cuisine|Kitchen;Salle de bain|Bathroom;Fenêtre|Window;Porte|Door;Chaise|Chair;Table|Table;Lit|Bed;Jardin|Garden\nAujourd'hui|Today;Demain|Tomorrow;Hier|Yesterday;Maintenant|Now;Toujours|Always;Jamais|Never;Souvent|Often;Parfois|Sometimes;Tôt|Early;Tard|Late\nPasseport|Passport;Billet|Ticket;Aéroport|Airport;Gare|Train station;Hôtel|Hotel;Valise|Suitcase;Bus|Bus;Train|Train;À gauche|To the left;À droite|To the right\nTravail|Work;Emploi|Job;Entretien|Interview;Réunion|Meeting;Collègue|Colleague;Salaire|Salary;Projet|Project;Bureau|Office;Entreprise|Company;Client|Customer\nÉcole|School;Professeur|Teacher;Élève|Pupil;Livre|Book;Cahier|Notebook;Stylo|Pen;Examen|Exam;Devoirs|Homework;Question|Question;Réponse|Answer\nJe comprends|I understand;Je ne sais pas|I don't know;Je suis d'accord|I agree;Ça dépend|It depends;Bonne chance|Good luck;Fais attention|Be careful;Ne t'inquiète pas|Don't worry;Prends ton temps|Take your time;Je voudrais|I would like;À mon avis|In my opinion\nJe suis prêt|I am ready;Tu es gentil|You are kind;Elle est ici|She is here;Nous sommes amis|We are friends;Il fait froid|It is cold;J'ai faim|I am hungry;J'ai soif|I am thirsty;Je peux aider|I can help;Je vais voyager|I am going to travel;Je t'aiderai|I will help you"
ARABIC=["مرحبا","شكرا","مساء الخير","تصبح على خير","العفو","من فضلك","عذرا","أراك قريبا","أراك غدا","أهلا وسهلا","اسمي","تشرفت بمعرفتك","كيف حالك؟","أنا بخير","أنا طالب","أسكن هنا","أنا من المغرب","كم عمرك؟","عمري عشرون سنة","أتحدث الإنجليزية","يكون","يملك","يذهب","يفعل","يتحدث","يأكل","يشرب","يتعلم","يكتب","يقرأ","منزل","غرفة نوم","مطبخ","حمام","نافذة","باب","كرسي","طاولة","سرير","حديقة","اليوم","غدا","أمس","الآن","دائما","أبدا","غالبا","أحيانا","مبكرا","متأخرا","جواز سفر","تذكرة","مطار","محطة قطار","فندق","حقيبة سفر","حافلة","قطار","إلى اليسار","إلى اليمين","عمل","وظيفة","مقابلة","اجتماع","زميل","راتب","مشروع","مكتب","شركة","زبون","مدرسة","أستاذ","تلميذ","كتاب","دفتر","قلم","امتحان","واجبات منزلية","سؤال","جواب","أنا أفهم","لا أعرف","أنا موافق","هذا يعتمد","حظا موفقا","انتبه","لا تقلق","خذ وقتك","أود","في رأيي","أنا مستعد","أنت لطيف","هي هنا","نحن أصدقاء","الجو بارد","أنا جائع","أنا عطشان","يمكنني المساعدة","سأسافر","سأساعدك"]
groups=[line.split(';') for line in RAW.splitlines() if line.strip()]
assert len(groups)==10 and all(len(g)==10 for g in groups)
topics=['Bases','Présentations','Verbes','Maison','Temps','Voyage','Travail','École','Expressions','Grammaire']
out=BASE/'images'/'cours'
out.mkdir(parents=True,exist_ok=True)
bold='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
regular='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
arabic_font='/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf'
def font(n,b=False):return ImageFont.truetype(bold if b else regular,n)
def draw_center(d,t,y,size,color):
    f=font(size,True); words=t.split(); lines=[]; line=''
    for word in words:
        v=(line+' '+word).strip()
        if d.textbbox((0,0),v,font=f)[2]>860 and line: lines.append(line);line=word
        else:line=v
    lines.append(line)
    for line in lines:
        w=d.textbbox((0,0),line,font=f)[2]
        d.text(((1080-w)/2,y),line,font=f,fill=color)
        y+=size+32
    return y
posts=[]
start=datetime.datetime(2026,10,17,tzinfo=datetime.timezone.utc)
for i,item in enumerate(sum(groups,[])):
    fr,en=item.split('|',1); ar=ARABIC[i]; topic=topics[i//10]
    f=out/f'{i+1:03}.png'
    if True:  # Rebuild all illustrations to include Arabic
        im=Image.new('RGB',(1080,1080),'#10244b')
        d=ImageDraw.Draw(im)
        d.rounded_rectangle((48,48,1032,1032),radius=45,fill='#f8faff')
        d.rounded_rectangle((48,48,1032,250),radius=45,fill='#2358c5')
        d.rectangle((48,195,1032,250),fill='#2358c5')
        draw_center(d,'FRANÇAIS · ENGLISH · العربية',100,35,'white')
        draw_center(d,f'LEÇON {i+1:03} / 100',179,25,'white')
        draw_center(d,fr,355,58,'#183566')
        draw_center(d,en,570,54,'#2358c5')
        af=ImageFont.truetype(arabic_font,58)
        d.text((540,745),ARABIC[i],font=af,fill='#147a66',anchor='mm',direction='rtl')
        d.line((125,825,955,825),fill='#b7c6df',width=4)
        draw_center(d,topic.upper(),850,28,'#345282')
        draw_center(d,'Apprends chaque jour !',950,23,'#345282')
        im.save(f,optimize=True)
    day=start+datetime.timedelta(days=i//4)
    hour=[8,11,16,19][i%4]
    scheduled=day.replace(hour=hour).isoformat().replace('+00:00','Z')
    posts.append({'id':f'cours-{i+1:03}','text':f'📚 Cours {i+1}/100 — {topic}\n🇫🇷 {fr}\n🇬🇧 {en}\n🇲🇦 {ar}\n💬 Utilise cette expression en commentaire !\n#LearnEnglish #ApprendreAnglais','image':f'images/cours/{i+1:03}.png','scheduledAt':scheduled,'targetNetworks':['facebook']})
if not (BASE/'posts.json').exists() or (BASE/'posts.json').read_text(encoding='utf-8').strip()=='[]':
    (BASE/'posts.json').write_text(json.dumps(posts,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(f'Generated {len(posts)} image courses')
