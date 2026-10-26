/**
 * The handwritten notes on the home page. One writes itself in, stays a while, then gives way to the next.
 * Keep each under about 110 characters so it fits the card, and end with a full stop.
 */
export interface FieldNote {
  text: string;
  /** Small print under the note. */
  from: string;
}

export const fieldNotes: FieldNote[] = [
  { text: '6:10am, the Mara. A lioness in the long grass, forty metres out. Nobody in the vehicle said a word.', from: 'Notes from one of our guides' },
  { text: 'Amboseli, 6:40am. The cloud lifted off Kilimanjaro for ten minutes. Long enough.', from: 'From the guide’s seat' },
  { text: 'Tsavo. Red elephants, red dust, red sun. By day two you stop noticing the colour.', from: 'Notes from one of our guides' },
  { text: 'Diani, low tide. The water goes out so far you can walk to the reef and back before lunch.', from: 'Written on the beach' },
  { text: 'Lake Nakuru at dawn. The shoreline turns pink, then it moves. Flamingos, thousands of them.', from: 'Notes from one of our guides' },
  { text: 'Samburu. A gerenuk up on its back legs, stretching for the acacia. Everyone laughed.', from: 'From the guide’s seat' },
  { text: 'Laikipia, after dark. No lights for miles, and more stars than sky.', from: 'Notes from one of our guides' },
  { text: 'Lamu. No cars on the island. The donkeys know the way better than we do.', from: 'Written in the old town' },
  { text: 'Naivasha, 7am. Hippos grumbling below the jetty. Tea tastes better out here.', from: 'Notes from one of our guides' },
  { text: 'The Mara in August. The river crossing took four minutes. We waited three hours. Worth it.', from: 'From the guide’s seat' },
  { text: 'Past Narok, the tarmac turns to murram and the whole vehicle goes quiet with excitement.', from: 'Notes from one of our guides' },
  { text: 'Hell’s Gate, on bikes. Zebra on the left, giraffe on the right, gorge walls ahead.', from: 'Written at the trailhead' },
  { text: 'Laikipia. A rhino and her calf, close enough to hear them breathing.', from: 'Notes from one of our guides' },
  { text: 'Night drive. Two green eyes in the torchlight, then the shape around them. Leopard.', from: 'From the guide’s seat' },
  { text: 'Back at camp, 9pm. Lanterns, dinner, and somewhere close, a lion calling.', from: 'Notes from one of our guides' },
];
