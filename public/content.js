// Text for the topic pages and blog. Edit freely: this file is plain data.
// Keep every claim true for your site (no made-up user numbers or features).
const DATE = '2026-10-10';

// slug must match the room name used in /chat#slug
const topics = [
  { slug: 'lobby', name: 'Lobby',
    title: 'Lobby: free general chat room, no sign-up | JenChat',
    desc: 'Join the JenChat lobby, a free general chat room for anyone. Pick a nickname, say hi and talk about anything. No registration needed.',
    h1: 'Lobby chat room',
    intro: 'The lobby is the default room on JenChat, where most people land first. It is the place to say hello, ask what others are up to, or find out which other rooms are busy.',
    talk: ['Introductions and where you are from (a country or city is enough)', 'What you are watching, playing or listening to today', 'Questions you want a quick opinion on', 'Finding a busier room to move to'],
    tips: ['Keep personal details such as your phone number and address out of the chat.', 'If the lobby is quiet, try a topic room such as music or gaming.'],
    faq: [['Do I need an account to use the lobby?', 'No. Pick a nickname and you are in.'], ['Are lobby messages saved?', 'Only the last 50 messages of an active room are kept in memory. They are removed when the room empties or the server restarts.']] },
  { slug: 'music', name: 'Music',
    title: 'Music chat room: talk songs and artists | JenChat',
    desc: 'A free music chat room. Share songs, ask for recommendations and talk about artists, albums and concerts with other fans. No sign-up.',
    h1: 'Music chat room',
    intro: 'Talk about songs, artists, playlists and concerts with other music fans. Whether you like Bollywood, hip hop, lo-fi or rock, the music room is a quick way to find something new to listen to.',
    talk: ['A song you cannot stop replaying', 'Recommendations similar to an artist you like', 'Albums, live shows and old classics', 'Learning an instrument or making your own music'],
    tips: ['Write the song and artist name so people can search for it easily.', 'Be open to other tastes. People here listen to very different things.'],
    faq: [['Can I share music links?', 'You can type song names and artists. Avoid posting the same link again and again, because spam can be reported.'], ['What if I do not like someone\'s taste?', 'That is fine. Disagree politely and move on.']] },
  { slug: 'gaming', name: 'Gaming',
    title: 'Gaming chat room: talk games with players | JenChat',
    desc: 'A free gaming chat room for mobile, PC and console players. Ask for tips, compare favourite games and chat while you wait for a match.',
    h1: 'Gaming chat room',
    intro: 'Find people to talk about video games, from mobile titles to PC and console. Ask for tips, compare favourites or just chat while you wait for a match.',
    talk: ['Which game you are playing this week', 'Tips for a level, build or boss you are stuck on', 'Mobile versus PC versus console', 'Upcoming releases and sales'],
    tips: ['Never share account passwords or login codes, even if someone offers free items.', 'JenChat is text only, so use it to chat, not to trade accounts.'],
    faq: [['Can I find teammates here?', 'You can ask. Share only your in-game name, not personal contact details.'], ['Is voice chat available?', 'No. JenChat is text only at the moment.']] },
  { slug: 'anime', name: 'Anime',
    title: 'Anime chat room: talk anime and manga | JenChat',
    desc: 'A free anime and manga chat room. Talk about what you are watching, debate favourite arcs and find your next series. No sign-up.',
    h1: 'Anime chat room',
    intro: 'A room for anime and manga fans. Talk about what you are watching, argue about the best arc or find a new series after you finish an old favourite.',
    talk: ['Seasonal anime and what is worth watching', 'Manga versus anime adaptations', 'Underrated shows you want more people to see', 'Favourite openings and characters'],
    tips: ['Warn others before sharing spoilers. Writing "spoiler" first is enough.', 'Name the series when you ask for recommendations, so people can suggest similar ones.'],
    faq: [['Is it okay to talk about spoilers?', 'Add a clear warning first, and stop if someone says they have not finished the series.'], ['Which language should I use?', 'You can use any language, but English helps the most people understand you.']] },
  { slug: 'movies', name: 'Movies',
    title: 'Movies chat room: what to watch tonight | JenChat',
    desc: 'A free movies and series chat room. Ask what to watch, discuss endings and compare Hollywood, Bollywood and world cinema. No sign-up.',
    h1: 'Movies chat room',
    intro: 'Chat about films and series with other people who like to watch. Ask what to watch tonight, discuss an ending or compare the book with the movie.',
    talk: ['What to watch this weekend', 'Favourite directors and actors', 'Hollywood, Bollywood and world cinema', 'Endings and plot theories'],
    tips: ['Mark spoilers, especially for new releases.', 'When you ask for a recommendation, say which genre or mood you want.'],
    faq: [['Can I ask for recommendations?', 'Yes. Say what you liked recently and what mood you are in.'], ['Are there spoiler rules?', 'Please warn others before revealing endings.']] },
  { slug: 'news', name: 'News',
    title: 'News chat room: talk current events | JenChat',
    desc: 'A free chat room to discuss current events and headlines. Keep it civil, check your sources and hear other views. No sign-up.',
    h1: 'News chat room',
    intro: 'Discuss current events and what is happening in the world. This room is for conversation, not for spreading rumours, so keep it civil and check things before you repeat them.',
    talk: ['The big headlines of the day', 'Technology, business and science news', 'Local news from your city or country', 'How to tell reliable reports from rumours'],
    tips: ['Say where you read something, and treat unverified claims with care.', 'Disagreement is fine. Personal attacks and hate are not, and they can be reported.'],
    faq: [['Does JenChat check the facts shared here?', 'No. Messages come from other users, so check important claims with a trusted news source.'], ['How do I report abuse?', 'Use the report link under a message.']] },
  { slug: 'english', name: 'English learning',
    title: 'English practice chat room for learners | JenChat',
    desc: 'Practice English by chatting with real people. Beginners welcome. Free, no sign-up, works on your phone.',
    h1: 'English practice chat room',
    intro: 'Practice English with people from different places. Beginners are welcome. Mistakes are part of learning, so type freely and ask when you do not understand something.',
    talk: ['Everyday small talk: hobbies, work and study', 'New words and what they mean', 'Asking others to correct your sentences politely', 'Preparing for interviews, exams or speaking tests'],
    tips: ['Write full sentences when you can, even short ones. It builds the habit.', 'If someone corrects you, say thanks and try the sentence again.'],
    faq: [['Is this room only for beginners?', 'No. All levels are welcome.'], ['How can I practise well?', 'Chat a little every day, keep a list of new words and try using them in your next conversation.']] },
  { slug: 'food', name: 'Food',
    title: 'Food chat room: recipes and cooking tips | JenChat',
    desc: 'A free food chat room. Share recipes, restaurant tips and cooking questions, from quick student meals to festival sweets.',
    h1: 'Food chat room',
    intro: 'Share recipes, restaurant tips and cooking questions. From quick student meals to festival sweets, this room is for anyone who likes talking about what to eat.',
    talk: ['What you cooked or ate today', 'Easy recipes for beginners', 'Regional dishes from your home town', 'Cooking tips and kitchen mistakes'],
    tips: ['If you share a recipe, use short messages with quantities so it is easy to follow.', 'Respect different diets, such as vegetarian, vegan or halal.'],
    faq: [['Can I ask for a recipe?', 'Yes. Say which ingredients you have and someone may suggest something.'], ['Can I share food photos?', 'Not yet. JenChat is text only for now.']] },
  { slug: 'friends', name: 'Friends',
    title: 'Make friends online: friendly chat room | JenChat',
    desc: 'Meet new people and make friends through casual conversation. Free guest chat for adults, no sign-up needed.',
    h1: 'Friends chat room',
    intro: 'Meet new people and make friends through casual conversation. Be curious, be kind, and remember that online friendships grow slowly, just like friendships anywhere else.',
    talk: ['Hobbies and weekend plans', 'Study, work and life in your city', 'Funny stories from your week', 'Books, shows and games you both like'],
    tips: ['Keep it friendly and never pressure anyone to share personal details or photos.', 'If someone makes you uncomfortable, stop replying and report the message.'],
    faq: [['Is it safe to give my number or social media?', 'It is safer not to. Get to know people for a while first, and never share your address or financial details.'], ['Is JenChat only for adults?', 'Yes. You must be 18 or older to use it.']] },
  { slug: 'memes', name: 'Memes',
    title: 'Memes chat room: jokes and humour | JenChat',
    desc: 'A relaxed chat room for jokes, memes and random humour. Tell a joke or describe the meme that made you laugh. No sign-up.',
    h1: 'Memes chat room',
    intro: 'A relaxed room for jokes, memes and random humour. Tell a joke, describe your favourite meme or share what made you laugh today.',
    talk: ['Jokes and one-liners', 'Memes you keep seeing everywhere', 'Funny things that happened this week', 'Silly debates, like tea versus coffee'],
    tips: ['Keep humour kind. Jokes that target a person or a group can get reported.', 'Short messages land better than long ones.'],
    faq: [['Can I post images?', 'Not at the moment. You can describe the meme in text.'], ['What is not allowed?', 'Hateful, harassing or sexual content involving minors is never allowed. See the terms of use.']] },
  { slug: 'science', name: 'Science',
    title: 'Science chat room: space, tech and biology | JenChat',
    desc: 'A free science and technology chat room. Ask questions about space, physics, biology and computers, or explain what you learned.',
    h1: 'Science chat room',
    intro: 'Talk about science and technology, from space and physics to biology and computers. Ask questions, share something you learned or explain a topic in simple words.',
    talk: ['Space, planets and astronomy news', 'How everyday things work', 'Coding, AI and gadgets', 'Questions from school or college subjects'],
    tips: ['When you answer a question, keep it simple and say when you are not sure.', 'Be careful with medical advice. Ask a doctor for health decisions.'],
    faq: [['Can I get homework help?', 'You can ask for explanations. Understanding the idea is more useful than copying an answer.'], ['Are the answers reliable?', 'Not always. Answers come from other users, so check important facts in a trusted source.']] },
  { slug: 'history', name: 'History',
    title: 'History chat room: talk about the past | JenChat',
    desc: 'A free history chat room. Talk about ancient civilisations, empires, famous people and the events that shaped the world.',
    h1: 'History chat room',
    intro: 'For people who enjoy the past. Talk about ancient civilisations, wars, empires and famous people, and how events shaped the world we live in today.',
    talk: ['Favourite periods and why they matter', 'The history of your own country or city', 'Famous leaders and turning points', 'Books, documentaries and museums'],
    tips: ['History can be sensitive. Discuss it with respect, even when people disagree.', 'Name the period or event you mean so others can follow.'],
    faq: [['Can I talk about politics here?', 'History often touches politics. Keep it respectful and avoid insults.'], ['Can I ask for book suggestions?', 'Yes. Tell people which era or region interests you.']] },
];

const articles = [
  { slug: 'chat-safely-with-strangers-online', date: DATE,
    title: 'How to chat safely with strangers online',
    desc: 'Practical rules for staying safe in anonymous chat rooms: what to keep private, how to spot scams, and how to block and report.',
    body: `<p>Talking to strangers can be fun and interesting. It can also go wrong if you are careless. These simple habits keep you safe without taking the fun out of it.</p>
<h2>Keep personal details private</h2>
<p>Your nickname is enough. Do not share your full name, address, school or workplace, phone number, or photos of your documents. Even small pieces, like your exact neighbourhood and the time you leave home, add up. If someone asks for these things quickly, treat that as a warning sign.</p>
<h2>Watch for scams and pressure</h2>
<ul><li>Nobody you just met needs your money, gift cards, bank details or one-time passwords.</li>
<li>Be careful with offers that sound too good, such as free game items or easy money.</li>
<li>Be careful when someone rushes you, flatters you a lot, or asks you to move to another app straight away.</li>
<li>Never click a link just because a stranger sent it.</li></ul>
<h2>Do not trust everything you read</h2>
<p>People can pretend to be anyone: another age, another gender or an expert. Enjoy the chat, but do not make important decisions based on what a stranger says about themselves.</p>
<h2>Use block and report</h2>
<p>On JenChat every message has a <strong>block</strong> link, which hides that person's messages for you, and a <strong>report</strong> link, which sends the message to the moderators for review. You do not need to explain yourself or argue. Block, report and move on.</p>
<h2>Use private rooms carefully</h2>
<p>A private room is not shown in the public list, but anyone who has the link can join. Share the link only with people you know, and remember that the room owner can remove people from the online list.</p>
<h2>Trust your instincts and take breaks</h2>
<p>If a conversation makes you uncomfortable, you can stop replying at any time. You do not owe anyone an answer. If something serious happens, such as threats or blackmail, stop the conversation, keep the evidence and tell someone you trust or the local authorities.</p>
<p>JenChat is for people aged 18 and over. If you meet someone who seems younger, do not continue the chat and report the messages.</p>` },
  { slug: 'conversation-starters-for-chat-rooms', date: DATE,
    title: '15 conversation starters for chat rooms',
    desc: 'Not sure what to say? Here are 15 easy questions that start real conversations in a chat room, from light and funny to thoughtful.',
    body: `<p>The hardest part of a chat room is the first message. "Hi" often gets no reply, because it gives people nothing to answer. A good opener is short, easy to answer and about something other than yourself only.</p>
<h2>Light and easy</h2>
<ol><li>What is the best thing you ate this week?</li>
<li>Tea or coffee, and how do you take it?</li>
<li>What song is stuck in your head right now?</li>
<li>Which show or movie did you finish last?</li>
<li>If you could instantly learn one skill, what would it be?</li></ol>
<h2>Fun and a little silly</h2>
<ol start="6"><li>What is a harmless opinion you will defend forever?</li>
<li>What was your first mobile phone?</li>
<li>Which food is overrated?</li>
<li>What is the funniest thing that happened to you recently?</li></ol>
<h2>A bit deeper</h2>
<ol start="10"><li>What is something small that made your day better lately?</li>
<li>What is a place you would like to visit, and why?</li>
<li>What did you want to be when you were a child?</li>
<li>What is the best advice you ever got?</li>
<li>What are you learning right now?</li></ol>
<h2>15. Ask for a recommendation</h2>
<p>"Can anyone recommend a good series to watch this weekend?" works well because people like to give advice. This is why topic rooms such as <a href="/topic/movies">movies</a> and <a href="/topic/music">music</a> are often easier to start in than the lobby.</p>
<h2>Tips for keeping it going</h2>
<ul><li>Answer your own question too. It shows you are friendly.</li>
<li>Ask a follow-up about what someone said instead of jumping to a new topic.</li>
<li>Keep messages short. Long paragraphs are hard to read in a fast chat.</li>
<li>Do not take silence personally. People come and go.</li></ul>` },
  { slug: 'practice-english-by-chatting-online', date: DATE,
    title: 'How to practise English by chatting online',
    desc: 'A simple routine to improve your English through chat: what to write, how to learn from mistakes and how to stay consistent.',
    body: `<p>Classes and apps are useful, but real conversation is where English starts to feel natural. Chatting online is a good way to practise, because you have a few seconds to think before you reply and nobody hears your accent.</p>
<h2>1. Start with simple, real topics</h2>
<p>Talk about things you already know: your day, your hobbies, your favourite food, your city. You will find the words faster when you care about the subject. Topic rooms such as <a href="/topic/food">food</a> and <a href="/topic/movies">movies</a> work well for this.</p>
<h2>2. Write full sentences</h2>
<p>It is tempting to type single words. Try a complete sentence each time, even a short one: "I like spicy food because it tastes strong." Writing whole sentences trains grammar without feeling like a lesson.</p>
<h2>3. Ask for corrections politely</h2>
<p>You can say, "Please correct my English if you see a mistake." Many people are happy to help. If you get a correction, say thanks and write the sentence again the right way. Repeating it helps you remember.</p>
<h2>4. Keep a small word list</h2>
<p>When you meet a new word or phrase, write it in a note on your phone with an example sentence. Try to use two or three of them in your next chat. Using a word yourself is the best way to keep it.</p>
<h2>5. Do a little every day</h2>
<p>Ten or fifteen minutes a day beats two hours once a week. Join the <a href="/topic/english">English practice room</a> at the same time each day and it soon becomes a habit.</p>
<h2>6. Do not be afraid of mistakes</h2>
<p>Everyone who learns a language makes mistakes. People in a chat room care more about what you say than about perfect grammar. If you do not understand something, just ask, "What does that mean?"</p>
<h2>A note on safety</h2>
<p>Practise with strangers, but do not share personal details. Read our guide on <a href="/blog/chat-safely-with-strangers-online">chatting safely with strangers</a> before you start.</p>` },
  { slug: 'how-to-make-a-private-chat-room', date: DATE,
    title: 'How to create a private chat room and invite friends',
    desc: 'Step by step: make a private JenChat room in a few seconds, share the invite link and remove people you do not want there.',
    body: `<p>A private room is a chat space just for you and the people you invite. It does not need an account, and it takes only a few seconds to set up.</p>
<h2>Create the room</h2>
<ol><li>Open <a href="/chat">the chat page</a>.</li>
<li>Type a nickname and tick the box that says you are 18 or older.</li>
<li>Press <strong>Enter chat</strong>.</li>
<li>In the left panel, press <strong>Create private room</strong>.</li></ol>
<p>A box appears with the invite link. Copy it and send it to your friends in any app. On a phone, the room list opens with the <strong>Rooms</strong> button.</p>
<h2>What makes it private</h2>
<ul><li>The room is not shown in the public list, so people cannot find it by browsing.</li>
<li>Its name is a long random code that is hard to guess.</li>
<li>Only the last 50 messages are kept in memory while the room is active, and they are removed when the room is empty or the server restarts.</li></ul>
<h2>Be careful with the link</h2>
<p>Anyone who has the link can join. If you post it in a public place, it is no longer private. Share it only with people you trust.</p>
<h2>Remove people you do not want</h2>
<p>The person who created the room is the owner. Press the online count at the top, find the person in the list and press <strong>Kick</strong>. They are removed and cannot rejoin that room for an hour. Your owner status is saved in your own browser, so use the same browser and device if you come back to the room.</p>
<h2>Other tools</h2>
<ul><li><strong>Block</strong> hides one person's messages just for you.</li>
<li><strong>Report</strong> sends a message to the moderators.</li>
<li>The emoji button and the typing indicator work in private rooms too.</li></ul>
<p>For tips on staying safe, read <a href="/blog/chat-safely-with-strangers-online">how to chat safely with strangers online</a>.</p>` },
];

module.exports = { topics, articles, DATE };
