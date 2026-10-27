import type {ReactNode} from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Alarms in Homey',
    description: (
      <>
        Motion and sound alarms from the monitor show up in Homey, so a flow can
        flash a lamp, send a notification or turn on the night light the moment
        your baby stirs.
      </>
    ),
  },
  {
    title: 'Night Light and Lullabies',
    description: (
      <>
        Turn the night light on or off, set its brightness, and play, stop or skip
        any of the 15 sounds on the monitor, with the monitor's own timers.
      </>
    ),
  },
  {
    title: 'Live Video',
    description: (
      <>
        Watch the camera from the device in the Homey app. Privacy mode turns the
        camera off whenever you want it off.
      </>
    ),
  },
  {
    title: 'SenseIQ',
    description: (
      <>
        On SenseIQ models, see whether your baby is in the crib, follow the
        breathing rate, and react when your baby starts or stops crying.
      </>
    ),
  },
];

function Feature({title, description}: FeatureItem) {
  return (
    <div className={clsx('col col--6')}>
      <div className="text--center padding-horiz--md padding-vert--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
