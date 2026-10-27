import type {ReactNode} from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  icon: string;
  tone: 'amber' | 'blue' | 'blush' | 'mint';
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Alarms in Homey',
    icon: '/img/icons/alarm.svg',
    tone: 'amber',
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
    icon: '/img/icons/lullaby-track.svg',
    tone: 'blush',
    description: (
      <>
        Turn the night light on or off, set its brightness, and play, stop or skip
        any of the 15 sounds on the monitor, with the monitor's own timers.
      </>
    ),
  },
  {
    title: 'Live Video',
    icon: '/img/icons/camera.svg',
    tone: 'blue',
    description: (
      <>
        Watch the camera from the device in the Homey app. Privacy mode turns the
        camera off whenever you want it off.
      </>
    ),
  },
  {
    title: 'SenseIQ',
    icon: '/img/icons/breathing-rate.svg',
    tone: 'mint',
    description: (
      <>
        On SenseIQ models, see whether your baby is in the crib, follow the
        breathing rate, and react when your baby starts or stops crying.
      </>
    ),
  },
];

function Feature({title, icon, tone, description}: FeatureItem) {
  const iconUrl = `url(${useBaseUrl(icon)})`;
  return (
    <div className={clsx('col col--6', styles.featureCol)}>
      <div className={clsx(styles.featureCard, styles[tone])}>
        <span className={styles.featureBadge} aria-hidden="true">
          <span
            className={styles.featureIcon}
            style={{maskImage: iconUrl, WebkitMaskImage: iconUrl}}
          />
        </span>
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
